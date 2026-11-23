import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createBroker} from './workspace-model-broker.mjs';
import {encryptKey, writeRoute, STATS_FILE} from './model-route-core.mjs';

const SCOPED = 's'.repeat(40), GW_KEY = 'g'.repeat(40), USER_KEY = 'sk-user-' + 'u'.repeat(40);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const logged = [];
for (const name of ['log', 'error', 'warn', 'info']) { const original = console[name]; console[name] = (...args) => { logged.push(args.join(' ')); original(...args); }; }

async function fake(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    req.body = Buffer.concat(chunks).toString(); server.hits.push(req); handler(req, res);
  });
  server.hits = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  server.url = `http://127.0.0.1:${server.address().port}`;
  return server;
}

async function setup({source = 'user-then-ghostwire', user, gw, model = 'user-model', firstByteMs = 2000, nonStreamMs = 4000, now, providerId = 'fake'} = {}) {
  const userServer = await fake(user || ((req, res) => res.end('{"from":"user"}')));
  const gwServer = await fake(gw || ((req, res) => res.end('{"from":"ghostwire"}')));
  const dir = mkdtempSync(join(tmpdir(), 'broker-')), master = randomBytes(32);
  const masterKeyFile = join(dir, 'master'), filterFile = join(dir, 'filter.json');
  writeFileSync(masterKeyFile, master.toString('base64'));
  writeFileSync(filterFile, JSON.stringify({deny: ['*:free'], allow_only: {}, min_context_tokens: 0}));
  const routeDir = join(dir, 'route');
  (await import('node:fs')).mkdirSync(routeDir);
  const route = {version: 1, source, provider: providerId, model, key_enc: encryptKey(master, USER_KEY), key_last4: 'uuuu', updated_at: 1};
  writeRoute(routeDir, route);
  const registry = new Map([[providerId, {id: providerId, name: 'Fake', base_url: userServer.url + '/v1', models_auth: 'bearer', key_pattern: null, enabled: true}]]);
  const broker = createBroker({
    env: {WORKSPACE_MODE: 'premium', MODEL_ENDPOINT: gwServer.url + '/', MODEL_UPSTREAM_TOKEN: GW_KEY, WORKSPACE_MODEL_TOKEN: SCOPED, MODEL_ID: 'gw-model'},
    routeDir, masterKeyFile, filterFile, registry, pollMs: 20, statsMs: 0, firstByteMs, nonStreamMs, now,
  });
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const base = `http://127.0.0.1:${broker.address().port}`;
  const call = (path = '/v1/chat/completions', body = {model: 'ghostwire', messages: [{role: 'user', content: 'hi'}]}, token = SCOPED) =>
    fetch(base + path, {method: path === '/v1/models' ? 'GET' : 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'}, body: path === '/v1/models' ? undefined : JSON.stringify(body)});
  const close = () => { broker.close(); userServer.close(); gwServer.close(); };
  return {userServer, gwServer, routeDir, master, route, filterFile, call, close, broker};
}

test('uses the user route with the user key and model', async t => {
  const s = await setup(); t.after(s.close);
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'user');
  assert.deepEqual(await response.json(), {from: 'user'});
  assert.equal(s.userServer.hits[0].url, '/v1/chat/completions');
  assert.equal(s.userServer.hits[0].headers.authorization, 'Bearer ' + USER_KEY);
  assert.equal(JSON.parse(s.userServer.hits[0].body).model, 'user-model');
  assert.equal(s.gwServer.hits.length, 0);
});

for (const status of [401, 403, 408, 429, 500, 503]) {
  test(`falls back to Ghost Wire on provider ${status}`, async t => {
    const s = await setup({user: (req, res) => { res.writeHead(status); res.end('{}'); }}); t.after(s.close);
    const response = await s.call();
    assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
    assert.deepEqual(await response.json(), {from: 'ghostwire'});
    assert.equal(JSON.parse(s.gwServer.hits[0].body).model, 'gw-model');
    assert.equal(s.gwServer.hits[0].headers.authorization, 'Bearer ' + GW_KEY);
  });
}

test('falls back when the provider is unreachable', async t => {
  const s = await setup(); t.after(s.close);
  s.userServer.close(); s.userServer.closeAllConnections();
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
});

test('falls back when the provider sends nothing before the first-byte timeout', async t => {
  const s = await setup({user: () => {}, firstByteMs: 150}); t.after(() => { s.userServer.closeAllConnections(); s.close(); });
  const response = await s.call(undefined, {model: 'ghostwire', stream: true, messages: []});
  assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
});

for (const status of [400, 404, 422]) {
  test(`does not fall back on provider ${status}`, async t => {
    const s = await setup({user: (req, res) => { res.writeHead(status, {'content-type': 'application/json'}); res.end('{"error":"bad"}'); }}); t.after(s.close);
    const response = await s.call();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('x-ghostwire-route'), 'user');
    assert.equal(s.gwServer.hits.length, 0);
  });
}

test('does not fall back after the first byte was streamed', async t => {
  const s = await setup({user: (req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.write('data: {"part":1}\n\n'); setTimeout(() => res.destroy(), 50); }}); t.after(s.close);
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'user');
  let text = '';
  try { text = await response.text(); } catch {}
  assert.ok(!text.includes('ghostwire'));
  assert.equal(s.gwServer.hits.length, 0);
});

test('user-only source returns the provider error without fallback', async t => {
  const s = await setup({source: 'user', user: (req, res) => { res.writeHead(500); res.end('{}'); }}); t.after(s.close);
  const response = await s.call();
  assert.equal(response.status, 500);
  assert.equal(s.gwServer.hits.length, 0);
});

test('ghostwire source never calls the provider', async t => {
  const s = await setup({source: 'ghostwire'}); t.after(s.close);
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
  assert.equal(s.userServer.hits.length, 0);
});

test('circuit opens after three failures and half-opens after 60 seconds', async t => {
  let clock = 1_000_000;
  const s = await setup({now: () => clock, user: (req, res) => { res.writeHead(500); res.end('{}'); }}); t.after(s.close);
  for (let i = 0; i < 4; i++) await (await s.call()).text();
  assert.equal(s.userServer.hits.length, 3);
  assert.equal(s.gwServer.hits.length, 4);
  clock += 60_001;
  await (await s.call()).text();
  assert.equal(s.userServer.hits.length, 4);
});

test('auth failure locks the user route until the key is replaced', async t => {
  let clock = 1_000_000;
  const s = await setup({now: () => clock, user: (req, res) => { res.writeHead(401); res.end('{}'); }}); t.after(s.close);
  await (await s.call()).text();
  clock += 120_000;
  await (await s.call()).text();
  assert.equal(s.userServer.hits.length, 1);
  writeRoute(s.routeDir, {...s.route, key_enc: encryptKey(s.master, USER_KEY + 'x'), updated_at: 2});
  await delay(100);
  await (await s.call()).text();
  assert.equal(s.userServer.hits.length, 2);
});

test('a newly denied model falls back and is reported', async t => {
  const s = await setup(); t.after(s.close);
  writeFileSync(s.filterFile, JSON.stringify({deny: ['*user-model*'], allow_only: {}, min_context_tokens: 0}));
  await delay(100);
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
  assert.equal(s.userServer.hits.length, 0);
  assert.equal(JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8')).last_error_class, 'model_not_allowed');
});

test('a route change applies to the next request only', async t => {
  const s = await setup({user: (req, res) => { res.writeHead(200); res.write('old-'); setTimeout(() => res.end('end'), 200); }}); t.after(s.close);
  const pending = s.call();
  await delay(50);
  writeRoute(s.routeDir, {...s.route, source: 'ghostwire', updated_at: 3});
  await delay(100);
  assert.equal(await (await pending).text(), 'old-end');
  const next = await s.call();
  assert.equal(next.headers.get('x-ghostwire-route'), 'ghostwire');
});

test('an unreadable route file serves Ghost Wire and reports config', async t => {
  const s = await setup(); t.after(s.close);
  writeRoute(s.routeDir, {...s.route, key_enc: 'v1:AAAA:BBBB:CCCC', updated_at: 4});
  await delay(100);
  const response = await s.call();
  assert.equal(response.headers.get('x-ghostwire-route'), 'ghostwire');
  assert.equal(JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8')).last_error_class, 'config');
});

test('stats count user and fallback calls per hour', async t => {
  let fail = false;
  const s = await setup({user: (req, res) => { if (fail) { res.writeHead(500); res.end(); } else res.end('{}'); }}); t.after(s.close);
  await (await s.call()).text();
  fail = true;
  await (await s.call()).text();
  const stats = JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8'));
  const hour = Object.values(stats.hours)[0];
  assert.deepEqual(hour, {user: 1, fallback: 1, error: 0});
  assert.equal(stats.last_route, 'ghostwire');
  assert.equal(stats.last_error_class, 'provider_down');
});

test('keeps existing broker behaviour', async t => {
  const s = await setup({source: 'ghostwire'}); t.after(s.close);
  assert.equal((await s.call(undefined, undefined, 'wrong'.repeat(10))).status, 401);
  assert.deepEqual((await (await s.call('/v1/models')).json()).data[0].id, 'ghostwire');
  await (await s.call()).text();
  assert.equal(JSON.parse(s.gwServer.hits[0].body).model, 'gw-model');
  assert.ok(existsSync(s.routeDir));
});

test('never logs the user key', () => {
  assert.ok(!logged.some(line => line.includes(USER_KEY)));
});

test('user-only source with an unreadable route fails instead of billing Ghost Wire', async t => {
  const s = await setup({source: 'user'}); t.after(s.close);
  writeRoute(s.routeDir, {...s.route, key_enc: 'v1:AAAA:BBBB:CCCC', updated_at: 5});
  await delay(100);
  const response = await s.call();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'config'});
  assert.equal(s.gwServer.hits.length, 0);
});

test('a provider 403 counts toward the circuit instead of locking the key', async t => {
  let clock = 1_000_000;
  const s = await setup({now: () => clock, user: (req, res) => { res.writeHead(403); res.end('{}'); }}); t.after(s.close);
  await (await s.call()).text();
  await (await s.call()).text();
  assert.equal(s.userServer.hits.length, 2);
});

test('a later user success clears the last error class', async t => {
  let fail = true;
  const s = await setup({user: (req, res) => { if (fail) { res.writeHead(500); res.end(); } else res.end('{}'); }}); t.after(s.close);
  await (await s.call()).text();
  fail = false;
  await (await s.call()).text();
  assert.equal(JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8')).last_error_class, null);
});

test('a slow non-streaming answer is not cut off by the first-byte timeout', async t => {
  const s = await setup({firstByteMs: 150, nonStreamMs: 2000, user: (req, res) => setTimeout(() => res.end('{"from":"user"}'), 400)}); t.after(s.close);
  const response = await s.call(undefined, {model: 'ghostwire', stream: false, messages: []});
  assert.equal(response.headers.get('x-ghostwire-route'), 'user');
  assert.equal(s.gwServer.hits.length, 0);
});

test('a transient route read error recovers without a file change', async t => {
  const s = await setup(); t.after(s.close);
  const {utimesSync, statSync} = await import('node:fs');
  const file = join(s.routeDir, 'route.private.json');
  const good = readFileSync(file);
  const {atime, mtime} = statSync(file);
  writeFileSync(file, '{not json');
  utimesSync(file, atime, new Date(mtime.getTime() + 5000));
  await delay(100);
  assert.equal((await s.call()).headers.get('x-ghostwire-route'), 'ghostwire');
  writeFileSync(file, good);
  utimesSync(file, atime, new Date(mtime.getTime() + 5000));
  await delay(100);
  assert.equal((await s.call()).headers.get('x-ghostwire-route'), 'user');
});

const SIGNED_STREAM = [
  {choices: [{delta: {role: 'assistant', tool_calls: [{index: 0, id: 'call-1', type: 'function', function: {name: 'Write', arguments: ''}, extra_content: {google: {thought_signature: 'REAL-SIG'}}}]}}]},
  {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '{"path":"hello.txt"}'}}]}, finish_reason: 'tool_calls'}]},
].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
const followUp = {model: 'ghostwire', stream: true, messages: [
  {role: 'user', content: 'write hello'},
  {role: 'assistant', content: null, tool_calls: [{id: 'call-1', type: 'function', function: {name: 'Write', arguments: '{"path":"hello.txt"}'}}]},
  {role: 'tool', tool_call_id: 'call-1', content: 'written'},
]};
const signer = (req, res) => { res.writeHead(200, {'content-type': 'text/event-stream'}); res.end(SIGNED_STREAM); };

test('Gemini: thought signatures from a streamed tool call are sent back on the next turn', async t => {
  const s = await setup({providerId: 'gemini', user: signer}); t.after(s.close);
  assert.match(await (await s.call(undefined, {model: 'ghostwire', stream: true, messages: [{role: 'user', content: 'write hello'}]})).text(), /REAL-SIG/);
  await (await s.call(undefined, followUp)).text();
  const sent = JSON.parse(s.userServer.hits[1].body);
  assert.equal(sent.messages[1].tool_calls[0].extra_content.google.thought_signature, 'REAL-SIG');
  assert.equal(sent.model, 'user-model');
});

test('Gemini: a tool call the broker never saw gets the placeholder signature', async t => {
  const s = await setup({providerId: 'gemini', user: signer}); t.after(s.close);
  await (await s.call(undefined, followUp)).text();
  assert.equal(JSON.parse(s.userServer.hits[0].body).messages[1].tool_calls[0].extra_content.google.thought_signature, 'skip_thought_signature_validator');
});

test('other providers receive tool calls unchanged', async t => {
  const s = await setup({user: signer}); t.after(s.close);
  await (await s.call(undefined, {model: 'ghostwire', stream: true, messages: [{role: 'user', content: 'write hello'}]})).text();
  await (await s.call(undefined, followUp)).text();
  assert.equal(JSON.parse(s.userServer.hits[1].body).messages[1].tool_calls[0].extra_content, undefined);
});

test('Mistral: tool-call ids are rewritten to 9 alphanumerics before reaching the provider', async t => {
  const s = await setup({providerId: 'mistral'}); t.after(s.close);
  await (await s.call(undefined, followUp)).text();
  const sent = JSON.parse(s.userServer.hits[0].body);
  assert.match(sent.messages[1].tool_calls[0].id, /^[a-zA-Z0-9]{9}$/);
  assert.equal(sent.messages[2].tool_call_id, sent.messages[1].tool_calls[0].id);
});

test('Anthropic: sampling fields the provider rejects are removed', async t => {
  const s = await setup({providerId: 'anthropic'}); t.after(s.close);
  await (await s.call(undefined, {model: 'ghostwire', temperature: 0.1, top_p: 0.5, tool_choice: 'required', messages: [{role: 'user', content: 'hi'}]})).text();
  const sent = JSON.parse(s.userServer.hits[0].body);
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.top_p, undefined);
  assert.equal(sent.tool_choice, 'auto');
});

test('Ghost Wire route never gets provider rewrites', async t => {
  const s = await setup({source: 'ghostwire', providerId: 'anthropic'}); t.after(s.close);
  await (await s.call(undefined, {model: 'ghostwire', temperature: 0.1, messages: [{role: 'user', content: 'hi'}]})).text();
  assert.equal(JSON.parse(s.gwServer.hits[0].body).temperature, 0.1);
});

// ---- several saved routes -------------------------------------------------------------
import {writeRoutes} from './model-route-core.mjs';
async function setupRoutes({defaultId = 'aaaaaaaa', a, b, now} = {}) {
  const serverA = await fake(a || ((req, res) => res.end('{"from":"A"}')));
  const serverB = await fake(b || ((req, res) => res.end('{"from":"B"}')));
  const gwServer = await fake((req, res) => res.end('{"from":"ghostwire"}'));
  const dir = mkdtempSync(join(tmpdir(), 'broker-routes-')), master = randomBytes(32);
  const masterKeyFile = join(dir, 'master'), filterFile = join(dir, 'filter.json'), routeDir = join(dir, 'route');
  writeFileSync(masterKeyFile, master.toString('base64'));
  writeFileSync(filterFile, JSON.stringify({deny: [], allow_only: {}, min_context_tokens: 0}));
  (await import('node:fs')).mkdirSync(routeDir);
  const KEY_A = 'sk-a-' + 'a'.repeat(40), KEY_B = 'sk-b-' + 'b'.repeat(40);
  writeRoutes(routeDir, {version: 2, default_id: defaultId, routes: [
    {id: 'aaaaaaaa', label: 'A', provider: 'pa', model: 'model-a', key_enc: encryptKey(master, KEY_A), key_last4: 'aaaa', fallback: true, updated_at: 1},
    {id: 'bbbbbbbb', label: 'B', provider: 'pb', model: 'model-b', key_enc: encryptKey(master, KEY_B), key_last4: 'bbbb', fallback: false, updated_at: 1},
  ]});
  const registry = new Map([
    ['pa', {id: 'pa', name: 'PA', base_url: serverA.url + '/v1', models_auth: 'bearer', key_pattern: null, enabled: true}],
    ['pb', {id: 'pb', name: 'PB', base_url: serverB.url + '/v1', models_auth: 'bearer', key_pattern: null, enabled: true}],
  ]);
  const broker = createBroker({env: {WORKSPACE_MODE: 'premium', MODEL_ENDPOINT: gwServer.url + '/', MODEL_UPSTREAM_TOKEN: GW_KEY, WORKSPACE_MODEL_TOKEN: SCOPED, MODEL_ID: 'gw-model'},
    routeDir, masterKeyFile, filterFile, registry, pollMs: 20, statsMs: 0, now});
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const base = `http://127.0.0.1:${broker.address().port}`;
  const ask = model => fetch(base + '/v1/chat/completions', {method: 'POST', headers: {authorization: 'Bearer ' + SCOPED, 'content-type': 'application/json'}, body: JSON.stringify({model, messages: [{role: 'user', content: 'hi'}]})});
  const close = () => { broker.close(); serverA.close(); serverB.close(); gwServer.close(); };
  return {serverA, serverB, gwServer, routeDir, base, ask, close, KEY_A, KEY_B};
}

test('routes: byok:<id> picks that route; other names use the default', async t => {
  const s = await setupRoutes(); t.after(s.close);
  assert.deepEqual(await (await s.ask('byok:bbbbbbbb')).json(), {from: 'B'});
  assert.equal(s.serverB.hits[0].headers.authorization, 'Bearer ' + s.KEY_B);
  assert.equal(JSON.parse(s.serverB.hits[0].body).model, 'model-b');
  assert.deepEqual(await (await s.ask('ghostwire')).json(), {from: 'A'});
  assert.deepEqual(await (await s.ask('byok:zzzzzzzz')).json(), {from: 'A'}, 'unknown id falls back to the default');
  assert.equal(s.gwServer.hits.length, 0);
});

test('routes: Ghost Wire as default still lets a task pick a saved key', async t => {
  const s = await setupRoutes({defaultId: 'ghostwire'}); t.after(s.close);
  assert.deepEqual(await (await s.ask('ghostwire')).json(), {from: 'ghostwire'});
  assert.deepEqual(await (await s.ask('byok:aaaaaaaa')).json(), {from: 'A'});
});

test('routes: a rejected key locks only its own route', async t => {
  const s = await setupRoutes({b: (req, res) => { res.writeHead(401); res.end('{}'); }}); t.after(s.close);
  const locked = await s.ask('byok:bbbbbbbb');
  assert.equal(locked.status, 401, 'B has no fallback, so the provider error is returned');
  await locked.text();
  await (await s.ask('byok:bbbbbbbb')).text();
  assert.equal(s.serverB.hits.length, 1, 'B is locked after the first 401');
  assert.deepEqual(await (await s.ask('byok:aaaaaaaa')).json(), {from: 'A'}, 'A keeps working');
});

test('routes: /v1/models lists Ghost Wire and every saved route without keys', async t => {
  const s = await setupRoutes(); t.after(s.close);
  const list = await (await fetch(s.base + '/v1/models', {headers: {authorization: 'Bearer ' + SCOPED}})).json();
  assert.deepEqual(list.data.map(m => m.id), ['ghostwire', 'byok:aaaaaaaa', 'byok:bbbbbbbb']);
  assert.deepEqual(list.default_id, 'aaaaaaaa');
  const b = list.data.find(m => m.id === 'byok:bbbbbbbb');
  assert.deepEqual([b.label, b.provider, b.model, b.owned_by], ['B', 'pb', 'model-b', 'user']);
  assert.ok(!JSON.stringify(list).includes(s.KEY_A));
});

test('routes: stats are counted per route', async t => {
  const s = await setupRoutes(); t.after(s.close);
  await (await s.ask('byok:bbbbbbbb')).text();
  await (await s.ask('ghostwire')).text();
  const stats = JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8'));
  assert.equal(stats.routes.bbbbbbbb.user, 1);
  assert.equal(stats.routes.aaaaaaaa.user, 1);
});

test('routes: per-route stats cover only the last 24 hours', async t => {
  let clock = 1_000 * 3600 * 1000;
  const s = await setupRoutes({now: () => clock}); t.after(s.close);
  await (await s.ask('byok:bbbbbbbb')).text();
  clock += 25 * 3600 * 1000;
  await (await s.ask('byok:aaaaaaaa')).text();
  const stats = JSON.parse(readFileSync(join(s.routeDir, STATS_FILE), 'utf8'));
  assert.equal(stats.routes.aaaaaaaa.user, 1);
  assert.equal(stats.routes.bbbbbbbb, undefined, 'older than 24 h drops out');
});
