// Static safety checks on the own-PC compose app, as Docker itself resolves it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const file = fileURLToPath(new URL('./compose.yml', import.meta.url));
const resolved = JSON.parse(execFileSync('docker', ['compose', '-f', file, '--profile', 'setup', 'config', '--format', 'json'],
  {encoding: 'utf8'}));
const services = resolved.services;
const raw = readFileSync(file, 'utf8');

test('project name and services', () => {
  assert.equal(resolved.name, 'ghostwire-sidecar');
  assert.deepEqual(Object.keys(services).sort(), ['connector', 'model-broker', 'postgres', 'setup', 'worker']);
});

test('nothing listens on the host and nothing controls Docker', () => {
  for (const [name, service] of Object.entries(services)) {
    assert.ok(!service.ports?.length, name + ' publishes a port');
    assert.ok(!service.privileged, name + ' is privileged');
    assert.ok(!(service.volumes || []).some(v => String(v.source).includes('docker.sock')), name + ' mounts the Docker socket');
    assert.ok(!service.network_mode, name + ' uses a custom network mode');
  }
});

test('worker is isolated, read-only and sees one folder', () => {
  const worker = services.worker;
  assert.deepEqual(Object.keys(worker.networks), ['private']);
  assert.equal(resolved.networks.private.internal, true);
  assert.equal(worker.read_only, true);
  assert.deepEqual(worker.cap_drop, ['ALL']);
  assert.deepEqual([...worker.cap_add].sort(), ['CHOWN', 'SETGID', 'SETPCAP', 'SETUID']);
  assert.ok(worker.security_opt.includes('no-new-privileges:true'));
  assert.equal(worker.environment.GHOSTWIRE_RUN_AS, 'auto');
  assert.equal(worker.environment.GHOSTWIRE_SECRETS_DIR, '/worker-secrets');
  assert.equal(worker.environment.GHOSTWIRE_LLM_PROVIDER, 'openai');
  assert.equal(worker.environment.GHOSTWIRE_LLM_BASE_URL, 'http://model-broker:8791/v1');
  const binds = worker.volumes.filter(v => v.type === 'bind');
  assert.equal(binds.length, 1);
  assert.equal(binds[0].target, '/workspace');
  assert.match(binds[0].source.replace(/\\/g, '/'), /\/GhostWire$/);
  assert.match(raw, /source: ~\/GhostWire\n/);
  assert.ok(!worker.volumes.some(v => v.target === '/state'), 'worker must never mount the state volume');
  assert.ok(worker.volumes.some(v => v.target === '/worker-secrets' && v.read_only));
});

test('broker and connector talk only to the Ghost Wire API origin', () => {
  const broker = services['model-broker'].environment;
  assert.equal(broker.WORKSPACE_MODE, 'sidecar');
  assert.equal(broker.MODEL_ENDPOINT, 'https://app.ghost-wire.com/');
  assert.equal(broker.GHOST_WIRE_API_ORIGINS, 'https://app.ghost-wire.com');
  assert.deepEqual(Object.keys(services.connector.networks).sort(), ['outbound', 'private']);
  assert.deepEqual(services.setup.profiles, ['setup']);
});

test('images come from release variables so CI can pin digests', () => {
  for (const name of ['SIDECAR_AGENT_IMAGE', 'SIDECAR_WORKER_IMAGE', 'SIDECAR_POSTGRES_IMAGE']) assert.match(raw, new RegExp('\\$\\{' + name + '[:}-]'));
  assert.doesNotMatch(raw, /image: (?!\$\{)/, 'every image must use a variable');
  // Any other variable makes Docker ask "proceed with these variables?" on oci:// runs.
  const variables = new Set([...raw.matchAll(/\$\{([A-Z_]+)/g)].map(m => m[1]));
  assert.deepEqual([...variables].sort(), ['SIDECAR_AGENT_IMAGE', 'SIDECAR_POSTGRES_IMAGE', 'SIDECAR_WORKER_IMAGE']);
});
