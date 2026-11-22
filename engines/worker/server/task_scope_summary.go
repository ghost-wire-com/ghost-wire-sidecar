package server

import "net/http"

// taskScopeSummary returns authoritative task-local and inherited counts for
// UI summaries. It does not return rows, so large task histories remain paged.
func (s *Server) taskScopeSummary(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	count := func(kind string) (int, error) { return t.Store.CountByKind(kind) }
	ownIntents, err := count("intent")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	goals, err := count("goal")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	ownFindings, err := count("finding")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	inheritedIntents, inheritedFindings := 0, 0
	sources, err := t.Store.DirectSourceStores()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, source := range sources {
		intentCount, countErr := source.Store.CountByKindStates("intent", []string{"done", "blocked", "exhausted", "stopped"})
		if countErr != nil {
			writeErr(w, http.StatusInternalServerError, countErr.Error())
			return
		}
		findingCount, countErr := source.Store.CountByKind("finding")
		if countErr != nil {
			writeErr(w, http.StatusInternalServerError, countErr.Error())
			return
		}
		inheritedIntents += intentCount
		inheritedFindings += findingCount
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"own_intents":        ownIntents,
		"inherited_intents":  inheritedIntents,
		"goals":              goals,
		"own_findings":       ownFindings,
		"inherited_findings": inheritedFindings,
	})
}
