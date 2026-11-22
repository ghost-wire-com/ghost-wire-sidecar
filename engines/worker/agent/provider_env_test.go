package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFromEnvConsumesOpenAISecretFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "llm-token")
	if err := os.WriteFile(path, []byte("scoped-relay-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GHOSTWIRE_LLM_PROVIDER", "openai")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENAI_API_KEY_FILE", path)
	cfg, ok := FromEnv()
	if !ok || cfg.APIKey != "scoped-relay-token" {
		t.Fatalf("file key was not loaded: ok=%v key=%q", ok, cfg.APIKey)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("secret file still exists, stat err %v", err)
	}
}
