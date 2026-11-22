# Ghost Wire Sidecar

Run your Ghost Wire workspace on your own computer. Your work and files stay on your machine; AI requests go through your Ghost Wire account (or your own AI provider key, if you add one in the workspace).

## Install (one line)

1. Install and start [Docker Desktop](https://docs.docker.com/get-docker/) (Linux: Docker Engine with the Compose plugin).
2. In Ghost Wire, open **Get more features → Use my computer** and press **Copy**. The line contains a one-time pairing code that expires after 5 minutes.
3. Paste it into a terminal. The page shows **Connected** when it is done.

The line looks like this:

```
docker compose -f oci://ghcr.io/ghost-wire-com/sidecar:1.0.0 run --rm setup --code <code> && docker compose -f oci://ghcr.io/ghost-wire-com/sidecar:1.0.0 up -d
```

## What it runs

| Service | What it does | Network |
|---|---|---|
| `worker` | the workspace engine and its tools | internal only, no internet |
| `postgres` | the workspace database | internal only |
| `model-broker` | sends AI requests to Ghost Wire or your own provider key | internal + outbound |
| `connector` | one outbound connection to app.ghost-wire.com | internal + outbound |
| `setup` | pairs this computer once | outbound |

- Tools see **one folder**: `~/GhostWire` (change with `GHOSTWIRE_FOLDER=/path/to/folder`). Your home folder, a drive root or a parent of your home folder is refused.
- No ports are opened on your computer. Nothing mounts the Docker socket.
- Your account key stays with the broker and connector; the worker never sees it.

## Update, stop, uninstall

```
docker compose -f oci://ghcr.io/ghost-wire-com/sidecar:<version> pull
docker compose -f oci://ghcr.io/ghost-wire-com/sidecar:<version> up -d
docker compose -p ghostwire-sidecar down        # stop
docker compose -p ghostwire-sidecar down -v     # stop and delete all local data
```

## Troubleshooting

- **"all predefined address pools have been fully subnetted"**: Docker has run out of network ranges, usually from old projects. Remove unused networks with `docker network prune`, then run the line again.
- **"Cannot connect to the Docker daemon"**: start Docker Desktop and wait until it says it is running.
- **Pairing code expired**: codes last 5 minutes. Copy the line again from Ghost Wire; your data is kept.
- **A different folder (advanced)**: download `compose.yml` from the release, replace every `~/GhostWire` (the worker's folder, the two safety checks and the header comment) with your folder, and use `docker compose -f compose.yml …` instead of the `oci://` address. Your home folder, a drive root or a parent of your home folder is refused.

## Verify the images

Every release is built by [this repository's workflow](.github/workflows/release.yml) from a tagged commit, signed with Sigstore and attested by GitHub.

```
cosign verify ghcr.io/ghost-wire-com/sidecar-worker@sha256:<digest> \
  --certificate-identity-regexp 'https://github.com/ghost-wire-com/ghost-wire-sidecar/.github/workflows/release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://ghcr.io/ghost-wire-com/sidecar-worker@sha256:<digest> -R ghost-wire-com/ghost-wire-sidecar
```

The release page lists the exact digests and the pinned `compose.yml`.

## Responsible use

Scan only systems you own or are explicitly authorized to test. See [SECURITY.md](SECURITY.md).

## License and credits

AGPL-3.0. See [LICENSE](LICENSE). The workspace engine in `engines/worker` is based on [ARTEX-EN](https://github.com/KbaHaxor/ARTEX-EN) (AGPL-3.0); `engines/worker/UPSTREAM.json` records the imported revision and file hashes.
