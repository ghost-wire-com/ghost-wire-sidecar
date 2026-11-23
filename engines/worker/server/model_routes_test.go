package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ghost-wire/worker/agent"
	"github.com/Autumn-27/norma/llm"
)

func TestRoutedConfigOnlyForTheWorkspaceBroker(t *testing.T) {
	broker := agent.Config{Format: llm.FormatOpenAI, BaseURL: workspaceBrokerBase, APIKey: "scoped-token", Model: "ghostwire"}
	cfg, ok := routedConfig(broker, "byok:abcdefgh")
	if !ok || cfg.Model != "byok:abcdefgh" || cfg.APIKey != "scoped-token" || cfg.BaseURL != workspaceBrokerBase {
		t.Fatalf("routed = %+v, %v", cfg, ok)
	}
	if _, ok := routedConfig(broker, ""); ok {
		t.Fatal("an empty route means the default and must not re-target")
	}
	for _, bad := range []string{"byok:ABC", "gpt-5", "byok:abcdefgh; rm", "byok:abcdefg"} {
		if _, ok := routedConfig(broker, bad); ok {
			t.Fatalf("invalid route %q accepted", bad)
		}
	}
	direct := agent.Config{Format: llm.FormatOpenAI, BaseURL: "https://api.openai.com/v1", APIKey: "sk-x", Model: "gpt-5"}
	if _, ok := routedConfig(direct, "byok:abcdefgh"); ok {
		t.Fatal("a worker that talks to a real provider must never send route names")
	}
	if cfg, ok := routedConfig(broker, "ghostwire"); !ok || cfg.Model != "ghostwire" {
		t.Fatalf("ghostwire route = %+v, %v", cfg, ok)
	}
}

func TestModelRoutesListComesFromTheBroker(t *testing.T) {
	var auth string
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"object":"list","default_id":"aaaaaaaa","data":[` +
			`{"id":"ghostwire","owned_by":"ghost-wire"},` +
			`{"id":"byok:aaaaaaaa","owned_by":"user","label":"Gemini","provider":"gemini","model":"gemini-3.5-flash-lite"},` +
			`{"id":"byok:bbbbbbbb","owned_by":"user","label":"Broken","provider":"openai","model":"gpt-5","broken":true}]}`))
	}))
	defer fake.Close()
	restore := workspaceBrokerBase
	workspaceBrokerBase = fake.URL + "/v1"
	defer func() { workspaceBrokerBase = restore }()

	s := &Server{}
	s.llmOn, s.llmProv = true, &scriptedLLMProvider{}
	s.llmCfg = agent.Config{Format: llm.FormatOpenAI, BaseURL: workspaceBrokerBase, APIKey: "scoped-token", Model: "ghostwire"}
	rec := httptest.NewRecorder()
	s.listModelRoutes(rec, httptest.NewRequest("GET", "/api/model-routes", nil))
	var got struct {
		Available bool   `json:"available"`
		DefaultID string `json:"default_id"`
		Routes    []struct {
			ID, Label, Provider, Model string
			Broken                     bool
		} `json:"routes"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer scoped-token" {
		t.Fatalf("broker auth = %q", auth)
	}
	if !got.Available || got.DefaultID != "aaaaaaaa" || len(got.Routes) != 2 || got.Routes[0].ID != "byok:aaaaaaaa" || got.Routes[0].Label != "Gemini" || !got.Routes[1].Broken {
		t.Fatalf("routes = %+v", got)
	}

	other := &Server{}
	other.llmOn, other.llmProv = true, &scriptedLLMProvider{}
	other.llmCfg = agent.Config{Format: llm.FormatOpenAI, BaseURL: "https://api.openai.com/v1", APIKey: "sk-x", Model: "gpt-5"}
	rec = httptest.NewRecorder()
	other.listModelRoutes(rec, httptest.NewRequest("GET", "/api/model-routes", nil))
	if rec.Body.String() == "" || json.Unmarshal(rec.Body.Bytes(), &got) != nil || got.Available || len(got.Routes) != 0 {
		t.Fatalf("non-broker worker must report no routes, got %s", rec.Body.String())
	}
}
