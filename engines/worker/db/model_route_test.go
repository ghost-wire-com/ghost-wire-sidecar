package db

import (
	"testing"
	"time"
)

func TestValidModelRoute(t *testing.T) {
	for _, ok := range []string{"", "ghostwire", "byok:abcdefgh", "byok:a2b3c4d5"} {
		if !ValidModelRoute(ok) {
			t.Fatalf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"byok:ABCDEFGH", "byok:abc", "gpt-5", "byok:abcdefgh ", "ghostwire2"} {
		if ValidModelRoute(bad) {
			t.Fatalf("%q should be invalid", bad)
		}
	}
}

func TestModelRoutePinsRoundTrip(t *testing.T) {
	d, err := Open(testDSN(t))
	if err != nil {
		t.Skipf("postgres unavailable (%v) — skipping", err)
	}
	defer d.Close()
	id := time.Now().UnixNano() % 1_000_000_000
	t.Cleanup(func() { _ = d.SetModelRoute("task", id, ""); _ = d.SetModelRoute("conversation", id, "") })
	if r, err := d.ModelRoute("task", id); err != nil || r != "" {
		t.Fatalf("empty = %q, %v", r, err)
	}
	if err := d.SetModelRoute("task", id, "byok:abcdefgh"); err != nil {
		t.Fatal(err)
	}
	if err := d.SetModelRoute("task", id, "ghostwire"); err != nil {
		t.Fatal(err)
	}
	if r, _ := d.ModelRoute("task", id); r != "ghostwire" {
		t.Fatalf("updated = %q", r)
	}
	if r, _ := d.ModelRoute("conversation", id); r != "" {
		t.Fatalf("kinds must be separate, got %q", r)
	}
	if err := d.SetModelRoute("task", id, ""); err != nil {
		t.Fatal(err)
	}
	if r, _ := d.ModelRoute("task", id); r != "" {
		t.Fatalf("cleared = %q", r)
	}
	if d.SetModelRoute("task", id, "gpt-5") == nil || d.SetModelRoute("agent", id, "ghostwire") == nil {
		t.Fatal("invalid route or kind must be refused")
	}
}
