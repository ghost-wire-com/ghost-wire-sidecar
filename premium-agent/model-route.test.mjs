import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createModelRouteHandler} from './model-route.mjs';
import {createPremiumAgent} from './server.mjs';
import {ROUTE_FILE, STATS_FILE, readMasterKey, decryptKey} from './model-route-core.mjs';

const OPENAI_KEY = 'sk-proj-' + 'a'.repeat(40), ANTHROPIC_KEY = 'sk-ant-api03-' + 'b'.repeat(40);
const json = (res, code, data) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(data)); };

async function setup({reply = () => new Response('{}', {status: 200}), withDir = true, mode = 'api'} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'route-gw-'));
  const modelRouteDir = join(root, 'model-route'), modelRouteKeyFile = join(root, 'model-route.key');
  if (withDir) { mkdirSync(modelRouteDir); writeFileSync(modelRouteKeyFile, randomBytes(32).toString('base64')); }
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({url: String(url), init}); return reply(String(url), init); };
  const handler = createModelRouteHandler({hostedWorkspace: true, workspaceMode: mode, ...(withDir ? {modelRouteDir, modelRouteKeyFile} : {})}, json, {fetch});
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) json(res, 418, {unhandled: true}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = {}) => fetch_(base + '/engine/model-route' + path, method, body, {'x-ghostwire-mode': mode, ...headers});
  return {server, base, call, calls, modelRouteDir, modelRouteKeyFile, close: () => server.close()};
}
const fetch_ = (url, method, body, headers) => globalThis.fetch(url, {method, headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
const save = (s, body) => s.call('PUT', '', {source: 'user-then-ghostwire', provider: 'openai', model: 'gpt-5', key: OPENAI_KEY, ...body});

test('requires the workspace mode header and ignores other paths', async t => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call('GET', '', undefined, {'x-ghostwire-mode': 'premium'})).status, 403);
  const other = await fetch_(s.base + '/engine/tasks', 'GET', undefined, {'x-ghostwire-mode': 'api'});
  assert.equal(other.status, 418);
});

test('missing route dir returns 503 model_route_unavailable', async t => {
  const s = await setup({withDir: false}); t.after(s.close);
  const response = await s.call('GET', '');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'model_route_unavailable');
});

test('lists enabled providers without secrets', async t => {
  const s = await setup(); t.after(s.close);
  const {providers} = await (await s.call('GET', '/providers')).json();
  assert.equal(providers.length, 9);
  assert.deepEqual(Object.keys(providers[0]).sort(), ['id', 'name']);
});

test('rejects custom URLs, unknown providers, bad or filtered models and subscription tokens', async t => {
  const s = await setup(); t.after(s.close);
  const cases = [
    [{base_url: 'https://evil.example'}, 'base_url_not_allowed'],
    [{provider: 'nope'}, 'unknown_provider'],
    [{model: 'bad model'}, 'invalid_model'],
    [{model: 'text-embedding-3-large'}, 'model_not_allowed'],
    [{provider: 'anthropic', model: 'claude-opus-4-8', key: 'sk-ant-oat01-' + 'c'.repeat(40)}, 'subscription_token'],
    [{key: 'short'}, 'invalid_key_format'],
    [{source: 'everything'}, 'invalid_source'],
  ];
  for (const [body, code] of cases) {
    const response = await save(s, body);
    assert.equal(response.status, 400, code);
    assert.equal((await response.json()).code, code);
  }
  assert.equal(s.calls.length, 0);
  assert.equal(existsSync(join(s.modelRouteDir, ROUTE_FILE)), false);
});

test('saves a tested key encrypted and never returns it', async t => {
  const s = await setup(); t.after(s.close);
  const response = await save(s);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(OPENAI_KEY));
  const body = JSON.parse(text);
  assert.equal(body.configured, true);
  assert.equal(body.key_last4, 'aaaa');
  assert.equal(body.source, 'user-then-ghostwire');
  assert.equal(s.calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(s.calls[0].init.headers.authorization, 'Bearer ' + OPENAI_KEY);
  assert.equal(JSON.parse(s.calls[0].init.body).model, 'gpt-5');
  const file = readFileSync(join(s.modelRouteDir, ROUTE_FILE), 'utf8');
  assert.ok(!file.includes(OPENAI_KEY));
  assert.equal(decryptKey(readMasterKey(s.modelRouteKeyFile), JSON.parse(file).key_enc), OPENAI_KEY);
  const fetched = await (await s.call('GET', '')).text();
  assert.ok(!fetched.includes(OPENAI_KEY) && !fetched.includes('key_enc'));
});

for (const [status, code, http_] of [[401, 'key_rejected', 400], [403, 'key_rejected', 400], [404, 'model_unavailable', 400], [429, 'quota', 400], [500, 'provider_unavailable', 502]]) {
  test(`provider ${status} maps to ${code} and saves nothing`, async t => {
    const s = await setup({reply: () => new Response('{}', {status})}); t.after(s.close);
    const response = await save(s);
    assert.equal(response.status, http_);
    assert.equal((await response.json()).code, code);
    assert.equal(existsSync(join(s.modelRouteDir, ROUTE_FILE)), false);
  });
}

test('network failure maps to provider_unavailable', async t => {
  const s = await setup({reply: () => { throw Error('down'); }}); t.after(s.close);
  const response = await save(s);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'provider_unavailable');
});

test('changing only the source reuses the stored key without a test call', async t => {
  const s = await setup(); t.after(s.close);
  await save(s);
  const before = JSON.parse(readFileSync(join(s.modelRouteDir, ROUTE_FILE), 'utf8')).key_enc;
  const response = await s.call('PUT', '', {source: 'user', provider: 'openai', model: 'gpt-5'});
  assert.equal(response.status, 200);
  assert.equal(s.calls.length, 1);
  const stored = JSON.parse(readFileSync(join(s.modelRouteDir, ROUTE_FILE), 'utf8'));
  assert.equal(stored.source, 'user');
  assert.equal(stored.key_enc, before);
});

test('switching to Ghost Wire keeps the saved key for later', async t => {
  const s = await setup(); t.after(s.close);
  await save(s);
  const body = await (await s.call('PUT', '', {source: 'ghostwire'})).json();
  assert.equal(body.source, 'ghostwire');
  assert.equal(body.key_last4, 'aaaa');
});

test('saving a user source without any key is refused', async t => {
  const s = await setup(); t.after(s.close);
  const response = await s.call('PUT', '', {source: 'user', provider: 'openai', model: 'gpt-5'});
  assert.equal((await response.json()).code, 'invalid_key_format');
});

test('model listing is filtered and uses provider auth headers', async t => {
  const s = await setup({reply: url => url.endsWith('/models') ? Response.json({data: [{id: 'gpt-5'}, {id: 'text-embedding-3-small'}, {id: 'gpt-4o'}]}) : new Response('{}')}); t.after(s.close);
  const {models} = await (await s.call('POST', '/models', {provider: 'openai', key: OPENAI_KEY})).json();
  assert.deepEqual(models, ['gpt-4o', 'gpt-5']);
  assert.equal(s.calls[0].url, 'https://api.openai.com/v1/models');
  await s.call('POST', '/models', {provider: 'anthropic', key: ANTHROPIC_KEY});
  assert.equal(s.calls[1].url, 'https://api.anthropic.com/v1/models');
  assert.equal(s.calls[1].init.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(s.calls[1].init.headers['anthropic-version'], '2023-06-01');
});

test('model listing failure is reported as unavailable', async t => {
  const s = await setup({reply: () => new Response('{}', {status: 500})}); t.after(s.close);
  assert.deepEqual(await (await s.call('POST', '/models', {provider: 'openai', key: OPENAI_KEY})).json(), {models: [], listing: 'unavailable'});
});

test('test endpoint checks without saving', async t => {
  const s = await setup(); t.after(s.close);
  assert.deepEqual(await (await s.call('POST', '/test', {provider: 'openai', model: 'gpt-5', key: OPENAI_KEY})).json(), {ok: true});
  assert.equal(existsSync(join(s.modelRouteDir, ROUTE_FILE)), false);
});

test('unreadable stored key is reported', async t => {
  const s = await setup(); t.after(s.close);
  await save(s);
  writeFileSync(s.modelRouteKeyFile, randomBytes(32).toString('base64'));
  assert.equal((await (await s.call('GET', '')).json()).key_unreadable, true);
});

test('GET includes broker stats', async t => {
  const s = await setup(); t.after(s.close);
  writeFileSync(join(s.modelRouteDir, STATS_FILE), JSON.stringify({hours: {'1': {user: 2, fallback: 1, error: 0}}, last_route: 'user', last_error_class: null}));
  assert.equal((await (await s.call('GET', '')).json()).stats.last_route, 'user');
});

test('DELETE removes the saved route', async t => {
  const s = await setup(); t.after(s.close);
  await save(s);
  assert.deepEqual(await (await s.call('DELETE', '')).json(), {configured: false, source: 'ghostwire'});
  assert.equal(existsSync(join(s.modelRouteDir, ROUTE_FILE)), false);
  assert.equal((await (await s.call('GET', '')).json()).configured, false);
});

test('oversized bodies are refused', async t => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call('PUT', '', 'x'.repeat(9000))).status, 413);
});

test('gateway serves model-route before the engine proxy', async t => {
  const root = mkdtempSync(join(tmpdir(), 'route-agent-'));
  const agent = createPremiumAgent({secret: 'k'.repeat(40), testUserId: 9, engineUrl: 'http://127.0.0.1:9/', database: join(root, 'o.db'), hostedWorkspace: true, workspaceMode: 'api'});
  agent.listen(0, '127.0.0.1'); await once(agent, 'listening'); t.after(() => agent.close());
  const response = await fetch_(`http://127.0.0.1:${agent.address().port}/engine/model-route`, 'GET', undefined, {authorization: 'Bearer ' + 'k'.repeat(40), 'x-ghostwire-user': '9', 'x-ghostwire-mode': 'api'});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'model_route_unavailable');
});

test('non-object JSON bodies are refused as invalid requests', async t => {
  const s = await setup(); t.after(s.close);
  for (const body of ['null', '42', '"text"', '[1]']) {
    const response = await s.call('PUT', '', body);
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).code, 'invalid_request');
  }
});

test('model listing stops reading an oversized response', {timeout: 5000}, async t => {
  let sent = 0;
  const endless = () => new Response(new ReadableStream({pull(controller) { sent += 65536; controller.enqueue(new Uint8Array(65536).fill(32)); }}));
  const s = await setup({reply: url => url.endsWith('/models') ? endless() : new Response('{}')}); t.after(s.close);
  const body = await (await s.call('POST', '/models', {provider: 'openai', key: OPENAI_KEY})).json();
  assert.deepEqual(body, {models: [], listing: 'unavailable'});
  assert.ok(sent < 8 * 1024 * 1024);
});

// ---- several saved keys (/routes) ----------------------------------------------------
import {readRoutes} from './model-route-core.mjs';
const GEMINI_KEY = 'AQ.' + 'g'.repeat(40);
const addRoute = (s, body) => s.call('POST', '/routes', {provider: 'openai', model: 'gpt-5', key: OPENAI_KEY, fallback: true, ...body});

test('routes: add tests the key, stores it encrypted and never returns it; first route becomes default', async t => {
  const s = await setup(); t.after(s.close);
  const response = await addRoute(s, {label: 'Work OpenAI'});
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.match(created.route.id, /^[a-z2-7]{8}$/);
  assert.equal(s.calls.filter(c => c.url.endsWith('/chat/completions')).length, 1);
  const list = await (await s.call('GET', '/routes')).json();
  assert.equal(list.default_id, created.route.id);
  assert.deepEqual(list.routes.map(r => [r.label, r.provider, r.model, r.key_last4, r.fallback]), [['Work OpenAI', 'openai', 'gpt-5', 'aaaa', true]]);
  assert.ok(!JSON.stringify(list).includes(OPENAI_KEY));
  const stored = readRoutes(s.modelRouteDir).routes[0];
  assert.equal(decryptKey(readMasterKey(s.modelRouteKeyFile), stored.key_enc), OPENAI_KEY);
});

test('routes: a second route does not steal the default; label defaults to provider and model', async t => {
  const s = await setup(); t.after(s.close);
  const first = (await (await addRoute(s)).json()).route;
  const second = (await (await addRoute(s, {provider: 'gemini', model: 'gemini-3.5-flash-lite', key: GEMINI_KEY, label: undefined})).json()).route;
  const list = await (await s.call('GET', '/routes')).json();
  assert.equal(list.default_id, first.id);
  assert.equal(list.routes.find(r => r.id === second.id).label, 'Google Gemini · gemini-3.5-flash-lite');
});

test('routes: a rejected key is not saved', async t => {
  const s = await setup({reply: url => new Response('{}', {status: url.endsWith('/chat/completions') ? 401 : 200})}); t.after(s.close);
  const response = await addRoute(s);
  assert.equal((await response.json()).code, 'key_rejected');
  assert.equal((await (await s.call('GET', '/routes')).json()).routes.length, 0);
});

test('routes: update re-tests only when key or model change; label and fallback do not', async t => {
  const s = await setup(); t.after(s.close);
  const {route} = await (await addRoute(s)).json();
  const before = s.calls.length;
  await s.call('PUT', '/routes/' + route.id, {label: 'Renamed', fallback: false});
  assert.equal(s.calls.length, before, 'no provider call for label/fallback');
  await s.call('PUT', '/routes/' + route.id, {model: 'gpt-5-mini'});
  assert.equal(s.calls.length, before + 1, 'model change tests with the stored key');
  assert.equal(s.calls.at(-1).init.headers.authorization, 'Bearer ' + OPENAI_KEY);
  const list = await (await s.call('GET', '/routes')).json();
  assert.deepEqual([list.routes[0].label, list.routes[0].model, list.routes[0].fallback], ['Renamed', 'gpt-5-mini', false]);
  assert.equal((await s.call('PUT', '/routes/zzzzzzzz', {label: 'x'})).status, 404);
});

test('routes: set default, and deleting the default falls back to Ghost Wire', async t => {
  const s = await setup(); t.after(s.close);
  const a = (await (await addRoute(s)).json()).route;
  const b = (await (await addRoute(s, {provider: 'gemini', model: 'gemini-3.5-flash-lite', key: GEMINI_KEY})).json()).route;
  assert.equal((await s.call('PUT', '/default', {id: b.id})).status, 200);
  assert.equal((await (await s.call('GET', '/routes')).json()).default_id, b.id);
  assert.equal((await s.call('PUT', '/default', {id: 'zzzzzzzz'})).status, 404);
  await s.call('DELETE', '/routes/' + b.id);
  const list = await (await s.call('GET', '/routes')).json();
  assert.equal(list.default_id, 'ghostwire');
  assert.deepEqual(list.routes.map(r => r.id), [a.id]);
  assert.equal((await s.call('PUT', '/default', {id: 'ghostwire'})).status, 200);
});

test('routes: at most 12 saved keys', async t => {
  const s = await setup(); t.after(s.close);
  for (let i = 0; i < 12; i++) assert.equal((await addRoute(s, {label: 'k' + i})).status, 200);
  const response = await addRoute(s, {label: 'one too many'});
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'too_many_routes');
});

test('legacy single-route endpoints act on the default route', async t => {
  const s = await setup(); t.after(s.close);
  await addRoute(s, {label: 'A'});
  await addRoute(s, {provider: 'gemini', model: 'gemini-3.5-flash-lite', key: GEMINI_KEY, label: 'B'});
  const view = await (await s.call('GET', '')).json();
  assert.deepEqual([view.configured, view.provider, view.model], [true, 'openai', 'gpt-5']);
  await save(s, {source: 'ghostwire'});
  assert.equal((await (await s.call('GET', '/routes')).json()).default_id, 'ghostwire');
  assert.equal((await (await s.call('GET', '/routes')).json()).routes.length, 2, 'switching to Ghost Wire keeps saved keys');
});
