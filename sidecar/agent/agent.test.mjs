import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSecret} from './secrets.mjs';
import {validateFolder} from './folder.mjs';
import {runSetup, STATE_FILES} from './setup.mjs';
import {ensureWorkerAuth, connectorConfig} from './connector.mjs';

const temp = () => mkdtempSync(join(tmpdir(), 'gw-agent-'));
const credential = 'device-credential-' + 'c'.repeat(40);

function claimFetch(status = 200, user = 165) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({url, body: JSON.parse(init.body)});
    if (status !== 200) return {ok: false, status, json: async () => ({error: 'Pairing code is invalid or expired. Create a new code on the website.'})};
    return {ok: true, status, json: async () => ({device_id: 'dev-1', user_id: user, credential})};
  };
  return {fetch, calls};
}
const setupArgs = (stateDir, extra = {}) => ({stateDir, origin: 'https://app.ghost-wire.com', folder: '~/GhostWire', home: '/home/u', ...extra});

test('readSecret prefers env, then _FILE, else undefined', () => {
  const dir = temp(); const file = join(dir, 's'); writeFileSync(file, ' from-file \n');
  assert.equal(readSecret('A', {A: 'env', A_FILE: file}), 'env');
  assert.equal(readSecret('A', {A_FILE: file}), 'from-file');
  assert.equal(readSecret('A', {}), undefined);
});

test('validateFolder refuses unsafe folders', () => {
  const posix = {home: '/home/u', platform: 'linux'}, win = {home: 'C:\\Users\\u', platform: 'win32'};
  for (const bad of ['', '~', '~/', '/', '/home', '/home/u', '/home/u/', '/home/u/a,b', '/home/u/../x', '/etc'])
    assert.throws(() => validateFolder(bad, posix), /unsafe_folder/, bad);
  for (const bad of ['C:\\', 'C:/', 'C:', 'C:\\Users', 'C:\\Users\\u', 'D:\\'])
    assert.throws(() => validateFolder(bad, win), /unsafe_folder/, bad);
  assert.equal(validateFolder('~/GhostWire', posix), '/home/u/GhostWire');
  assert.equal(validateFolder('/home/u/GhostWire', posix), '/home/u/GhostWire');
  assert.equal(validateFolder('/srv/projects/scan', posix), '/srv/projects/scan');
  assert.equal(validateFolder('C:\\Users\\u\\GhostWire', win), 'C:\\Users\\u\\GhostWire');
  assert.equal(validateFolder('~/GhostWire', {platform: 'linux'}), '~/GhostWire'); // home unknown: keep text, still refuse ~ itself
  assert.throws(() => validateFolder('~', {platform: 'linux'}), /unsafe_folder/);
});

test('setup claims once and writes private state files', async () => {
  const stateDir = temp(); const {fetch, calls} = claimFetch();
  const result = await runSetup({...setupArgs(stateDir), code: '165:secret-code', name: 'My PC', fetch});
  assert.equal(result.status, 'claimed');
  assert.deepEqual(calls[0], {url: 'https://app.ghost-wire.com/api/sidecar/claim', body: {code: '165:secret-code', user_id: 165, name: 'My PC'}});
  assert.deepEqual(readdirSync(stateDir).sort(), [...STATE_FILES].sort());
  assert.equal(JSON.parse(readFileSync(join(stateDir, 'device.json'))).credential, credential);
  for (const name of ['postgres-password', 'scoped-token', 'engine-password', 'gateway-secret', 'jwt.key'])
    assert.ok(readFileSync(join(stateDir, name), 'utf8').length >= 32, name);
  assert.equal(Buffer.from(readFileSync(join(stateDir, 'model-route.key'), 'utf8'), 'base64').length, 32);
  if (process.platform !== 'win32') for (const name of STATE_FILES) assert.equal(statSync(join(stateDir, name)).mode & 0o777, 0o600, name);
});

test('setup without code on a paired PC changes nothing', async () => {
  const stateDir = temp(); await runSetup({...setupArgs(stateDir), code: '165:a', fetch: claimFetch().fetch});
  const before = Object.fromEntries(STATE_FILES.map(n => [n, readFileSync(join(stateDir, n), 'utf8')]));
  const {fetch, calls} = claimFetch();
  assert.equal((await runSetup({...setupArgs(stateDir), fetch})).status, 'unchanged');
  assert.equal(calls.length, 0);
  for (const n of STATE_FILES) assert.equal(readFileSync(join(stateDir, n), 'utf8'), before[n]);
});

test('setup with a new code on a paired PC replaces only the device', async () => {
  const stateDir = temp(); await runSetup({...setupArgs(stateDir), code: '165:a', fetch: claimFetch().fetch});
  const before = Object.fromEntries(STATE_FILES.map(n => [n, readFileSync(join(stateDir, n), 'utf8')]));
  const result = await runSetup({...setupArgs(stateDir), code: '165:b', fetch: claimFetch().fetch});
  assert.equal(result.status, 'replaced');
  for (const n of STATE_FILES.filter(n => n !== 'device.json')) assert.equal(readFileSync(join(stateDir, n), 'utf8'), before[n], n);
});

test('setup refuses a code for another account on a paired PC', async () => {
  const stateDir = temp(); await runSetup({...setupArgs(stateDir), code: '165:a', fetch: claimFetch().fetch});
  const {fetch, calls} = claimFetch(200, 7);
  await assert.rejects(runSetup({...setupArgs(stateDir), code: '7:x', fetch}), /same Ghost Wire account/);
  assert.equal(calls.length, 0);
});

test('setup with no state and no code explains what to do', async () => {
  await assert.rejects(runSetup({...setupArgs(temp()), fetch: claimFetch().fetch}), /pairing code/i);
});

test('expired code writes nothing and says how to fix it', async () => {
  const stateDir = temp();
  await assert.rejects(runSetup({...setupArgs(stateDir), code: '165:old', fetch: claimFetch(401).fetch}), /Create a new code on the website/);
  assert.deepEqual(readdirSync(stateDir), []);
});

test('unsafe folder is refused before any request', async () => {
  const {fetch, calls} = claimFetch();
  await assert.rejects(runSetup({...setupArgs(temp()), folder: '/home/u', code: '165:a', fetch}), /unsafe_folder|folder/);
  assert.equal(calls.length, 0);
});

test('setup never prints the credential', async () => {
  const lines = []; const original = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { await runSetup({...setupArgs(temp()), code: '165:a', fetch: claimFetch().fetch}); } finally { console.log = original; }
  assert.ok(!lines.join('\n').includes(credential));
});

test('ensureWorkerAuth initialises only when login is refused', async () => {
  const seen = [];
  const make = first => async (url, init) => { seen.push(new URL(url).pathname); const p = new URL(url).pathname;
    if (p === '/api/auth/login' && first.shift() === 401) return {ok: false, status: 401, json: async () => ({})};
    return {ok: true, status: 200, json: async () => ({token: 't'})}; };
  await ensureWorkerAuth({engineUrl: 'http://worker:8787', password: 'p'.repeat(40), fetch: make([200])});
  assert.deepEqual(seen, ['/api/auth/login']);
  seen.length = 0;
  await ensureWorkerAuth({engineUrl: 'http://worker:8787', password: 'p'.repeat(40), fetch: make([401, 200])});
  assert.deepEqual(seen, ['/api/auth/login', '/api/auth/init', '/api/auth/login']);
});

test('setup gives the worker only its own secrets, never the device credential', async () => {
  const stateDir = temp(), workerSecretsDir = temp();
  await runSetup({...setupArgs(stateDir), workerSecretsDir, code: '165:a', fetch: claimFetch().fetch});
  assert.deepEqual(readdirSync(workerSecretsDir).sort(), ['jwt.key', 'postgres-password', 'scoped-token']);
  for (const name of ['postgres-password', 'scoped-token', 'jwt.key'])
    assert.equal(readFileSync(join(workerSecretsDir, name), 'utf8'), readFileSync(join(stateDir, name), 'utf8'));
  for (const name of readdirSync(workerSecretsDir)) assert.ok(!readFileSync(join(workerSecretsDir, name), 'utf8').includes(credential));
  // A re-pair keeps the worker secrets identical.
  const before = readFileSync(join(workerSecretsDir, 'postgres-password'), 'utf8');
  await runSetup({...setupArgs(stateDir), workerSecretsDir, code: '165:b', fetch: claimFetch().fetch});
  assert.equal(readFileSync(join(workerSecretsDir, 'postgres-password'), 'utf8'), before);
});

test('connectorConfig builds the adapter from state', async () => {
  const stateDir = temp(); await runSetup({...setupArgs(stateDir), code: '165:a', fetch: claimFetch().fetch});
  const config = connectorConfig(stateDir);
  assert.equal(config.testUserId, 165);
  assert.equal(config.engineUrl, 'http://worker:8787');
  assert.equal(config.engineUsername, 'GHOSTWIRE');
  assert.equal(config.enginePassword, readFileSync(join(stateDir, 'engine-password'), 'utf8'));
  assert.equal(config.secret, readFileSync(join(stateDir, 'gateway-secret'), 'utf8'));
  assert.equal(config.credential, credential);
  assert.equal(config.database, join(stateDir, 'ownership.db'));
  assert.equal(config.hostedWorkspace, true);
  assert.equal(config.workspaceMode, 'api');
  assert.equal(config.modelRouteDir, '/route');
  assert.equal(config.miningOrigin, 'http://127.0.0.1:1/'); // own-PC has no mining node
  assert.equal(config.miningSecret, undefined);
  assert.deepEqual(config.modelChat, {url: 'http://model-broker:8791', token: readFileSync(join(stateDir, 'scoped-token'), 'utf8')});
  assert.equal(config.modelRouteKeyFile, join(stateDir, 'model-route.key'));
  assert.ok(existsSync(config.modelRouteKeyFile));
});
