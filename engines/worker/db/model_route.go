package db

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
)

// A model route names which saved AI key (bring-your-own-key) a conversation or task
// uses inside a hosted or own-PC workspace: "byok:<id>", "ghostwire", or "" for the
// workspace default. Stored apart from the conversation/task rows so existing
// queries stay untouched.
var modelRoutePattern = regexp.MustCompile(`^(ghostwire|byok:[a-z2-7]{8})$`)

// ValidModelRoute reports whether v is "" (default), "ghostwire" or "byok:<id>".
func ValidModelRoute(v string) bool { return v == "" || modelRoutePattern.MatchString(v) }

func checkRouteKind(kind string) error {
	if kind != "conversation" && kind != "task" {
		return fmt.Errorf("invalid model route kind %q", kind)
	}
	return nil
}

// ModelRoute returns the saved route for a conversation or task ("" = default).
func (d *DB) ModelRoute(kind string, id int64) (string, error) {
	if err := checkRouteKind(kind); err != nil {
		return "", err
	}
	var route string
	err := d.QueryRow(`SELECT model_route FROM model_route_pins WHERE kind=$1 AND ref_id=$2`, kind, id).Scan(&route)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return route, err
}

// SetModelRoute saves (or, for "", clears) the route of a conversation or task.
func (d *DB) SetModelRoute(kind string, id int64, route string) error {
	if err := checkRouteKind(kind); err != nil {
		return err
	}
	if !ValidModelRoute(route) {
		return fmt.Errorf("invalid model route %q", route)
	}
	if route == "" {
		_, err := d.Exec(`DELETE FROM model_route_pins WHERE kind=$1 AND ref_id=$2`, kind, id)
		return err
	}
	_, err := d.Exec(`INSERT INTO model_route_pins (kind, ref_id, model_route) VALUES ($1, $2, $3)
ON CONFLICT (kind, ref_id) DO UPDATE SET model_route=EXCLUDED.model_route, updated_at=now()`, kind, id, route)
	return err
}
