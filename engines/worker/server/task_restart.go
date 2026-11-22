package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"ghost-wire/worker/db"
)

// restartTask starts a fresh task run while preserving the task's graph,
// findings, assets and transcript history. It deliberately does not reopen or
// rerun any blocked intent; the planner sees the preserved graph and chooses
// the next work through normal admission.
func (s *Server) restartTask(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	lifecycle := t.lifecycleSnapshot()
	if !isTerminalStatus(lifecycle.Status) {
		writeErr(w, http.StatusConflict, "only a completed, failed, or timed-out task can be restarted")
		return
	}
	if s.engine.IsDeleting(t.ID) || !s.engine.beginTaskOperation(t.ID) {
		writeErr(w, http.StatusConflict, "the task is being deleted, so it cannot be restarted")
		return
	}
	defer s.engine.decInflight(t.ID)

	taskID, parseErr := strconv.ParseInt(t.ID, 10, 64)
	if parseErr != nil || taskID <= 0 {
		writeErr(w, http.StatusInternalServerError, "invalid task id")
		return
	}
	queued, err := s.admitFreshTaskRun(t)
	if err != nil {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	generation := fmt.Sprintf("restart-%d", time.Now().UTC().UnixNano())
	metadata, _ := json.Marshal(map[string]any{
		"event":      "task_restart",
		"generation": generation,
		"queued":     queued,
	})
	s.engine.emitActivity(t, db.Activity{
		Worker:   "system",
		Kind:     "text",
		Summary:  "task restarted as a fresh run generation; prior history was preserved",
		Metadata: metadata,
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"id":         t.ID,
		"restarted":  true,
		"generation": generation,
		"queued":     queued,
	})
}
