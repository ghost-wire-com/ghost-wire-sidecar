#!/bin/sh
set -eu

# Docker supplies the bootstrap values only to this short-lived launcher. The
# worker itself receives file paths, not credentials in its process environment.
# The Go process consumes and removes the files before starting any agent work.
secret_dir=/run/ghostwire-secrets
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

if [ -n "${GHOSTWIRE_BOOTSTRAP_PG_DSN:-}" ]; then
  umask 077
  printf '%s' "$GHOSTWIRE_BOOTSTRAP_PG_DSN" > "$secret_dir/postgres-dsn"
fi
if [ -n "${GHOSTWIRE_BOOTSTRAP_LLM_TOKEN:-}" ]; then
  umask 077
  printf '%s' "$GHOSTWIRE_BOOTSTRAP_LLM_TOKEN" > "$secret_dir/llm-token"
fi

# Own-PC Sidecar: secrets come from a root-only volume instead of the environment.
if [ -n "${GHOSTWIRE_SECRETS_DIR:-}" ]; then
  umask 077
  printf 'postgres://workspace:%s@postgres:5432/workspace?sslmode=disable' "$(cat "$GHOSTWIRE_SECRETS_DIR/postgres-password")" > "$secret_dir/postgres-dsn"
  cp "$GHOSTWIRE_SECRETS_DIR/scoped-token" "$secret_dir/llm-token"
fi

unset GHOSTWIRE_BOOTSTRAP_PG_DSN GHOSTWIRE_BOOTSTRAP_LLM_TOKEN GHOSTWIRE_SECRETS_DIR
export GHOSTWIRE_PG_DSN_FILE="$secret_dir/postgres-dsn"
export OPENAI_API_KEY_FILE="$secret_dir/llm-token"
# Own-PC Sidecar: read the secrets as root, then drop to a normal user for good, so
# tools started by the worker can't read the root-only originals.
if [ -n "${GHOSTWIRE_RUN_AS:-}" ]; then
  if [ "$GHOSTWIRE_RUN_AS" = auto ]; then
    # Use the owner of the shared folder (Linux: the person's own user); a folder Docker
    # just created belongs to root, so fall back to 1000.
    uid="$(stat -c %u /workspace 2>/dev/null || echo 0)"; gid="$(stat -c %g /workspace 2>/dev/null || echo 0)"
    if [ "$uid" = 0 ]; then uid=1000; gid=1000; fi
  else
    uid="${GHOSTWIRE_RUN_AS%%:*}"; gid="${GHOSTWIRE_RUN_AS##*:}"
  fi
  unset GHOSTWIRE_RUN_AS
  chown -R "$uid:$gid" "$secret_dir"
  for dir in /app/data /workspace; do
    if [ -d "$dir" ] && [ "$(stat -c %u "$dir")" != "$uid" ]; then chown "$uid:$gid" "$dir" 2>/dev/null || true; fi
  done
  if [ "$(stat -c %u /app/data)" = "$uid" ]; then find /app/data -xdev ! -user "$uid" -exec chown "$uid:$gid" {} + 2>/dev/null || true; fi
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups --inh-caps=-all --bounding-set=-all /app/ghostwire "$@"
fi
exec /app/ghostwire "$@"
