package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPostgresDSNPrecedence(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.json")
	os.WriteFile(cfgPath, []byte(`{"database":{"host":"10.1.2.3","port":6000,"user":"u","password":"p","dbname":"d","sslmode":"require"}}`), 0o644)
	t.Setenv("GHOSTWIRE_CONFIG", cfgPath)

	// no env DSN → built from config file fields
	t.Setenv("GHOSTWIRE_PG_DSN", "")
	got, _, err := PostgresDSN()
	want := "postgres://u:p@10.1.2.3:6000/d?sslmode=require"
	if err != nil || got != want {
		t.Fatalf("from file: got %q err %v want %q", got, err, want)
	}

	// env wins over config file
	t.Setenv("GHOSTWIRE_PG_DSN", "postgres://envwins/x")
	if got, _, err := PostgresDSN(); err != nil || got != "postgres://envwins/x" {
		t.Fatalf("env should win, got %q err %v", got, err)
	}

	// no env, no file → error (no built-in default)
	t.Setenv("GHOSTWIRE_PG_DSN", "")
	t.Setenv("GHOSTWIRE_CONFIG", filepath.Join(dir, "nope.json"))
	if got, _, err := PostgresDSN(); err == nil {
		t.Fatalf("missing config should error, got %q", got)
	}

	// full dsn in config file is used verbatim
	os.WriteFile(cfgPath, []byte(`{"database":{"dsn":"postgres://full/dsn"}}`), 0o644)
	t.Setenv("GHOSTWIRE_CONFIG", cfgPath)
	if got, _, err := PostgresDSN(); err != nil || got != "postgres://full/dsn" {
		t.Fatalf("file dsn verbatim, got %q err %v", got, err)
	}
}

func TestPostgresDSNSecretFileIsConsumed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dsn")
	if err := os.WriteFile(path, []byte("postgres://file-secret/db"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GHOSTWIRE_PG_DSN", "")
	t.Setenv("GHOSTWIRE_PG_DSN_FILE", path)
	t.Setenv("GHOSTWIRE_CONFIG", filepath.Join(t.TempDir(), "missing.json"))
	got, source, err := PostgresDSN()
	if err != nil || got != "postgres://file-secret/db" || source != "one-time secret file" {
		t.Fatalf("file DSN: got %q source %q err %v", got, source, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("secret file still exists, stat err %v", err)
	}
}
