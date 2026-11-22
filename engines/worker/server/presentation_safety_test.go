package server

import (
	"strings"
	"testing"
)

func TestRedactSensitiveText(t *testing.T) {
	got := redactSensitiveText("OPENAI_API_KEY=secret-value OPENAI_API_KEY wAz-Ogl-value PostgreSQL password dfcb2af4secret JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue Authorization: Bearer abc123 postgres://user:pass@10.0.0.2:5432/db")
	if got == "" || got == "OPENAI_API_KEY=secret-value" {
		t.Fatalf("redaction did not run: %q", got)
	}
	for _, leaked := range []string{"secret-value", "wAz-Ogl-value", "dfcb2af4secret", "eyJhbGciOiJIUzI1NiJ9", "abc123", "10.0.0.2"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("sensitive value %q leaked in %q", leaked, got)
		}
	}
}

func TestSafeTrafficTargetHidesInternalTargetsAndPorts(t *testing.T) {
	host, target := safeTrafficTarget("172.22.0.1:22", "http://172.22.0.1:22/install.sh")
	if host != "[internal target]" || target != "internal://target" {
		t.Fatalf("internal target was not hidden: host=%q target=%q", host, target)
	}
	host, target = safeTrafficTarget("example.test:443", "https://example.test:443/metrics")
	if host != "example.test" || target != "https://example.test/%5Bprotected%20endpoint%5D" {
		t.Fatalf("public protected target was not normalized: host=%q target=%q", host, target)
	}
}
