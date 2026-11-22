# Security

## Reporting a vulnerability

Email **security@ghost-wire.com** with steps to reproduce. Please do not open a public issue for security problems. We aim to reply within 3 working days.

## Security model

- **One folder.** The worker sees only the folder you chose (`GHOSTWIRE_FOLDER`, default `~/GhostWire`). Setup and the connector refuse your home folder, a drive or filesystem root, and any parent of your home folder.
- **No inbound access.** No service publishes a port. The connector opens one outbound TLS connection to `app.ghost-wire.com`.
- **No Docker control.** No container mounts the Docker socket or runs privileged.
- **Isolated worker.** The worker has no internet access (internal network), a read-only root filesystem, no Linux capabilities after start-up, and runs as a normal user. It reads its database password and AI token as root at start, then drops privileges for good; tools it runs cannot read those originals.
- **Account key separation.** The device credential is stored only in the `state` volume, mounted by the broker and connector, never by the worker.
- **Your own AI key (optional).** Stored encrypted in the `route` volume; only the broker decrypts it, and only for the fixed provider URLs in `premium-agent/model-providers.json`.
- **Pairing.** One-time codes expire after 5 minutes and work once. Disconnecting the computer on the website revokes its credential.

## Supply chain

Images are built by GitHub Actions from tagged commits in this repository, signed with Sigstore (keyless) and attested with GitHub build provenance and an SBOM. The published `compose.yml` pins every image by digest. See the README for verification commands.
