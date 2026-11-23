package server

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ghost-wire/worker/agent"
	"ghost-wire/worker/db"
	"github.com/Autumn-27/norma/llm"
	"github.com/Autumn-27/norma/transcript"
)

// workspaceBrokerBase is the model broker that hosted and own-PC workspaces talk to
// (set by their compose files). Only then may a conversation or task name one of the
// user's saved keys ("byok:<id>") as its model; the broker resolves it. A worker that
// talks to a real provider never sends route names. A var so tests can point it at a fake.
var workspaceBrokerBase = "http://model-broker:8791/v1"

// routedConfig re-targets the global (broker) config at a saved route.
func routedConfig(global agent.Config, route string) (agent.Config, bool) {
	if route == "" || !db.ValidModelRoute(route) || strings.TrimRight(global.BaseURL, "/") != workspaceBrokerBase {
		return agent.Config{}, false
	}
	cfg := global
	cfg.Model = route
	return cfg, true
}

// routeCache holds per-route providers/chat agents; the zero value is ready to use.
type routeCache struct {
	mu        sync.Mutex
	providers map[string]llm.Provider
	chats     map[string]*agent.ChatAgent
}

func (c *routeCache) reset() {
	c.mu.Lock()
	c.providers, c.chats = nil, nil
	c.mu.Unlock()
}

// routeProvider builds (and caches) the provider for a saved route.
func (s *Server) routeProvider(route string) (llm.Provider, agent.Config, bool) {
	global, gcfg, ok := s.globalProvider()
	if !ok || global == nil {
		return nil, agent.Config{}, false
	}
	cfg, ok := routedConfig(gcfg, route)
	if !ok {
		return nil, agent.Config{}, false
	}
	s.routes.mu.Lock()
	defer s.routes.mu.Unlock()
	if p := s.routes.providers[route]; p != nil {
		return p, cfg, true
	}
	prov, err := cfg.NewProvider()
	if err != nil {
		log.Printf("[engine] build provider for model route %s failed: %v", route, err)
		return nil, agent.Config{}, false
	}
	if s.routes.providers == nil {
		s.routes.providers = map[string]llm.Provider{}
	}
	s.routes.providers[route] = prov
	return prov, cfg, true
}

// chatAgentForRoute mirrors chatAgentForProfile for a saved route.
func (s *Server) chatAgentForRoute(route string) *agent.ChatAgent {
	s.routes.mu.Lock()
	cached := s.routes.chats[route]
	s.routes.mu.Unlock()
	if cached != nil {
		return cached
	}
	prov, cfg, ok := s.routeProvider(route)
	if !ok {
		return nil
	}
	tx := transcript.NewStore(filepath.Join(s.m.dir, "transcripts"))
	ca := agent.NewChatAgent(prov, cfg.Model, s.m.dir, tx, cfg.CompactionWindow())
	ca.SetProxy(s.m.ProxyAddr(), s.m.ProxyCACert())
	ca.SetWebSearch(s.m.WebSearchOpts())
	ca.SetGuard(s.chatGuard())
	ca.SetNonStreaming(nonStreamingResolver(cfg))
	ca.SetMaxTokens(maxTokensResolver(cfg))
	ca.SetNoaEnabled(s.m.NoaCompactionEnabled)
	s.routes.mu.Lock()
	defer s.routes.mu.Unlock()
	if ex := s.routes.chats[route]; ex != nil {
		return ex
	}
	if s.routes.chats == nil {
		s.routes.chats = map[string]*agent.ChatAgent{}
	}
	s.routes.chats[route] = ca
	return ca
}

// pinnedRoute reads a conversation/task route; errors mean "default".
func (s *Server) pinnedRoute(kind string, id int64) string {
	if s.m == nil || s.m.pg == nil {
		return ""
	}
	route, err := s.m.pg.ModelRoute(kind, id)
	if err != nil {
		return ""
	}
	return route
}

type modelRouteDTO struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Broken   bool   `json:"broken,omitempty"`
}

// listModelRoutes returns the user's saved keys as reported by the workspace broker.
// GET /api/model-routes → {available, default_id, routes:[{id:"byok:<id>",label,provider,model}]}
func (s *Server) listModelRoutes(w http.ResponseWriter, r *http.Request) {
	empty := map[string]any{"available": false, "default_id": "ghostwire", "routes": []modelRouteDTO{}}
	_, cfg, ok := s.globalProvider()
	if !ok || strings.TrimRight(cfg.BaseURL, "/") != workspaceBrokerBase {
		writeJSON(w, 200, empty)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, workspaceBrokerBase+"/models", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, 200, empty)
		return
	}
	defer resp.Body.Close()
	var listed struct {
		DefaultID string `json:"default_id"`
		Data      []struct {
			ID       string `json:"id"`
			OwnedBy  string `json:"owned_by"`
			Label    string `json:"label"`
			Provider string `json:"provider"`
			Model    string `json:"model"`
			Broken   bool   `json:"broken"`
		} `json:"data"`
	}
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&listed) != nil {
		writeJSON(w, 200, empty)
		return
	}
	routes := []modelRouteDTO{}
	for _, m := range listed.Data {
		if m.OwnedBy == "user" && db.ValidModelRoute(m.ID) && strings.HasPrefix(m.ID, "byok:") {
			routes = append(routes, modelRouteDTO{ID: m.ID, Label: m.Label, Provider: m.Provider, Model: m.Model, Broken: m.Broken})
		}
	}
	defaultID := listed.DefaultID
	if defaultID == "" {
		defaultID = "ghostwire"
	}
	writeJSON(w, 200, map[string]any{"available": true, "default_id": defaultID, "routes": routes})
}

// GET/PUT /api/conversations/{id}/route and /api/tasks/{id}/route  {model_route}
func (s *Server) modelRouteHandler(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pg := s.pg(w)
		if pg == nil {
			return
		}
		id, err := parseTaskID(r.PathValue("id"))
		if err != nil {
			writeErr(w, 400, "invalid id")
			return
		}
		if r.Method == http.MethodPut {
			var req struct {
				ModelRoute string `json:"model_route"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || !db.ValidModelRoute(req.ModelRoute) {
				writeErr(w, 400, "model_route must be empty, \"ghostwire\" or \"byok:<id>\"")
				return
			}
			if err := pg.SetModelRoute(kind, id, req.ModelRoute); err != nil {
				writeErr(w, 500, err.Error())
				return
			}
			if kind == "task" {
				s.invalidateTaskAgents()
			}
		}
		route, err := pg.ModelRoute(kind, id)
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"model_route": route})
	}
}
