import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {
  loadRegistry, loadFilter, modelAllowed, validateKey, validateModelId, readMasterKey, normalizeKey,
  encryptKey, decryptKey, readRoute, writeRoute, modelIds, ROUTE_FILE,
} from './model-route-core.mjs';

const here = new URL('.', import.meta.url);
const registryFile = new URL('model-providers.json', here);
const filterFile = new URL('model-filter.json', here);
const temp = () => mkdtempSync(join(tmpdir(), 'route-core-'));

test('shipped registry has exactly the approved providers', () => {
  const registry = loadRegistry(registryFile);
  assert.deepEqual([...registry.keys()].sort(), ['anthropic', 'deepseek', 'gemini', 'groq', 'mistral', 'openai', 'openrouter', 'together', 'xai']);
  assert.equal(registry.get('anthropic').base_url, 'https://api.anthropic.com/v1');
  assert.equal(registry.get('anthropic').models_auth, 'anthropic');
  assert.ok(registry.get('openai').key_pattern instanceof RegExp);
  assert.equal(registry.get('openrouter').key_pattern, null);
});

test('registry rejects non-https or credentialed base URLs', () => {
  for (const base_url of ['http://api.example.com/v1', 'https://user:pw@api.example.com', 'https://api.example.com/v1?x=1']) {
    const dir = temp();
    writeFileSync(join(dir, 'r.json'), JSON.stringify({providers: [{id: 'x', name: 'X', base_url, models_auth: 'bearer', enabled: true}]}));
    assert.throws(() => loadRegistry(join(dir, 'r.json')));
  }
});

test('default filter denies free, embedding and audio models and allows chat models', () => {
  const filter = loadFilter(filterFile);
  assert.equal(modelAllowed(filter, 'openrouter', 'meta/llama:free'), false);
  assert.equal(modelAllowed(filter, 'openai', 'text-embedding-3-small'), false);
  assert.equal(modelAllowed(filter, 'openai', 'whisper-1'), false);
  assert.equal(modelAllowed(filter, 'openai', 'gpt-5'), true);
  assert.equal(modelAllowed(filter, 'openai', 'gpt-5', 8000), false);
  assert.equal(modelAllowed(filter, 'openai', 'gpt-5', 200000), true);
});

test('allow_only limits a provider to matching models', () => {
  const filter = {...loadFilter(filterFile), allow_only: {openai: ['gpt-5*']}};
  assert.equal(modelAllowed(filter, 'openai', 'gpt-4o'), false);
  assert.equal(modelAllowed(filter, 'openai', 'GPT-5-mini'), true);
  assert.equal(modelAllowed(filter, 'anthropic', 'claude-opus-4-8'), true);
});

test('validateKey refuses subscription and malformed credentials', () => {
  const registry = loadRegistry(registryFile);
  const [openai, anthropic, openrouter] = ['openai', 'anthropic', 'openrouter'].map(id => registry.get(id));
  assert.equal(validateKey(anthropic, 'sk-ant-oat01-' + 'a'.repeat(40)).code, 'subscription_token');
  assert.equal(validateKey(openai, 'sk-ant-oat01-' + 'a'.repeat(40)).code, 'subscription_token');
  assert.equal(validateKey(openai, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl').code, 'subscription_token');
  assert.equal(validateKey(openrouter, 'sk-or-v1-abc def ' + 'x'.repeat(30)).code, 'invalid_key_format');
  assert.equal(validateKey(openrouter, 'session=' + 'x'.repeat(30) + ';').code, 'invalid_key_format');
  assert.equal(validateKey(openrouter, 'x'.repeat(19)).code, 'invalid_key_format');
  assert.equal(validateKey(openai, 'sk-ant-api03-' + 'a'.repeat(40)).code, 'invalid_key_format');
  assert.deepEqual(validateKey(anthropic, 'sk-ant-api03-' + 'a'.repeat(40)), {ok: true});
  assert.deepEqual(validateKey(openai, 'sk-proj-' + 'a'.repeat(40)), {ok: true});
  assert.deepEqual(validateKey(openrouter, 'sk-or-v1-' + 'a'.repeat(40)), {ok: true});
});

test('validateModelId accepts provider model ids and rejects others', () => {
  assert.equal(validateModelId('anthropic/claude-3.5-sonnet:beta'), true);
  assert.equal(validateModelId('gpt-5'), true);
  assert.equal(validateModelId(''), false);
  assert.equal(validateModelId('a b'), false);
  assert.equal(validateModelId('x'.repeat(129)), false);
});

test('key encryption round-trips, detects tampering and hides plaintext', () => {
  const master = randomBytes(32), key = 'sk-proj-' + 'z'.repeat(40);
  const blob = encryptKey(master, key);
  assert.match(blob, /^v1:/);
  assert.ok(!blob.includes(key));
  assert.equal(decryptKey(master, blob), key);
  const parts = blob.split(':');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  assert.throws(() => decryptKey(master, parts.join(':')));
  assert.throws(() => decryptKey(randomBytes(32), blob));
});

test('readMasterKey requires 32 bytes', () => {
  const dir = temp();
  writeFileSync(join(dir, 'k'), randomBytes(32).toString('base64'));
  assert.equal(readMasterKey(join(dir, 'k')).length, 32);
  writeFileSync(join(dir, 'short'), randomBytes(16).toString('base64'));
  assert.throws(() => readMasterKey(join(dir, 'short')));
});

test('route file round-trips privately and is null when absent', () => {
  const dir = temp();
  assert.equal(readRoute(join(dir, 'missing')), null);
  const route = {version: 1, source: 'user-then-ghostwire', provider: 'openai', model: 'gpt-5', key_enc: 'v1:a:b:c', key_last4: 'abcd', updated_at: 1};
  writeRoute(dir, route);
  assert.deepEqual(readRoute(dir), route);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, ROUTE_FILE), 'utf8')), route);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, ROUTE_FILE)).mode & 0o777, 0o600);
});

test('modelIds normalizes list shapes', () => {
  assert.deepEqual(modelIds({data: [{id: 'b'}, {id: 'a'}, {id: 'a'}]}), ['a', 'b']);
  assert.deepEqual(modelIds([{id: 'x'}]), ['x']);
  assert.deepEqual(modelIds('nope'), []);
  assert.equal(modelIds({data: Array.from({length: 600}, (_, i) => ({id: 'm' + i}))}).length, 500);
});

test('Gemini accepts both the classic AIza and the newer AQ. AI Studio key formats', () => {
  const registry = loadRegistry(registryFile);
  const gemini = registry.get('gemini');
  assert.deepEqual(validateKey(gemini, 'AIza' + 'A1b_-'.repeat(7)), {ok: true});
  assert.deepEqual(validateKey(gemini, 'AQ.' + 'Ab8RN6KLtZ-_'.repeat(4)), {ok: true});
  assert.equal(validateKey(gemini, 'AQ.short').code, 'invalid_key_format');
  assert.equal(validateKey(gemini, 'sk-proj-' + 'a'.repeat(40)).code, 'invalid_key_format');
});

test('normalizeKey trims pasted whitespace and leaves other values alone', () => {
  assert.equal(normalizeKey('  AQ.abc\r\n'), 'AQ.abc');
  assert.equal(normalizeKey('\tsk-proj-x '), 'sk-proj-x');
  assert.equal(normalizeKey(undefined), undefined);
  assert.equal(normalizeKey(42), 42);
});

test('Anthropic accepts current key types but never subscription (oat) tokens', () => {
  const anthropic = loadRegistry(registryFile).get('anthropic');
  assert.deepEqual(validateKey(anthropic, 'sk-ant-api03-' + 'a'.repeat(40)), {ok: true});
  assert.deepEqual(validateKey(anthropic, 'sk-ant-admin01-' + 'a'.repeat(40)), {ok: true});
  assert.equal(validateKey(anthropic, 'sk-ant-oat01-' + 'a'.repeat(40)).code, 'subscription_token');
  assert.equal(validateKey(anthropic, 'sk-proj-' + 'a'.repeat(40)).code, 'invalid_key_format');
});

// ---- v2 route store (several saved keys) -------------------------------------------
import * as routesCore from './model-route-core.mjs';
const v1 = (source, extra = {}) => ({version: 1, source, provider: 'gemini', model: 'gemini-3.5-flash-lite', key_enc: 'v1:a:b:c', key_last4: 'wxyz', updated_at: 5, ...extra});

test('readRoutes: no files means Ghost Wire default and no routes', () => {
  assert.deepEqual(routesCore.readRoutes(temp()), {version: 2, default_id: 'ghostwire', routes: []});
});

test('readRoutes migrates a single v1 route without touching files', () => {
  for (const [source, fallback, isDefault] of [['user', false, true], ['user-then-ghostwire', true, true], ['ghostwire', true, false]]) {
    const dir = temp();
    routesCore.writeRoute(dir, v1(source));
    const store = routesCore.readRoutes(dir);
    assert.equal(store.version, 2);
    assert.equal(store.routes.length, 1, source);
    const [route] = store.routes;
    assert.match(route.id, /^[a-z2-7]{8}$/);
    assert.equal(route.provider, 'gemini');
    assert.equal(route.model, 'gemini-3.5-flash-lite');
    assert.equal(route.key_enc, 'v1:a:b:c');
    assert.equal(route.fallback, fallback, source);
    assert.equal(store.default_id, isDefault ? route.id : 'ghostwire', source);
    assert.equal(routesCore.readRoutes(dir).routes[0].id, route.id, 'stable id across reads');
  }
  const dir = temp();
  routesCore.writeRoute(dir, {version: 1, source: 'ghostwire'});
  assert.deepEqual(routesCore.readRoutes(dir).routes, [], 'Ghost Wire with no saved key migrates to no routes');
});

test('writeRoutes stores v2 and mirrors the default into the v1 file for older brokers', () => {
  const dir = temp();
  const a = {id: 'aaaaaaaa', label: 'Gemini', provider: 'gemini', model: 'm1', key_enc: 'v1:1:1:1', key_last4: '1111', fallback: true, updated_at: 1};
  const b = {id: 'bbbbbbbb', label: 'OpenAI', provider: 'openai', model: 'm2', key_enc: 'v1:2:2:2', key_last4: '2222', fallback: false, updated_at: 2};
  routesCore.writeRoutes(dir, {version: 2, default_id: 'bbbbbbbb', routes: [a, b]});
  assert.deepEqual(routesCore.readRoutes(dir), {version: 2, default_id: 'bbbbbbbb', routes: [a, b]});
  const mirror = routesCore.readRoute(dir);
  assert.equal(mirror.source, 'user');
  assert.equal(mirror.provider, 'openai');
  assert.equal(mirror.key_enc, 'v1:2:2:2');
  routesCore.writeRoutes(dir, {version: 2, default_id: 'ghostwire', routes: [a]});
  assert.equal(routesCore.readRoute(dir).source, 'ghostwire');
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, routesCore.ROUTES_FILE)).mode & 0o777, 0o600);
});

test('writeRoutes refuses more than 12 routes, bad ids and a default that does not exist', () => {
  const route = i => ({id: ('a' + i).padEnd(8, 'a').replace(/[^a-z2-7]/g, 'b'), label: 'x', provider: 'openai', model: 'm', key_enc: 'v1:1:1:1', key_last4: '1111', fallback: true, updated_at: 1});
  const many = Array.from({length: 13}, (_, i) => ({...route(i), id: routesCore.newRouteId()}));
  assert.throws(() => routesCore.writeRoutes(temp(), {version: 2, default_id: 'ghostwire', routes: many}));
  assert.throws(() => routesCore.writeRoutes(temp(), {version: 2, default_id: 'ghostwire', routes: [{...route(1), id: 'BAD'}]}));
  assert.throws(() => routesCore.writeRoutes(temp(), {version: 2, default_id: 'zzzzzzzz', routes: []}));
});

test('newRouteId is 8 base32 characters and publicRoutes never exposes keys', () => {
  const ids = new Set(Array.from({length: 50}, () => routesCore.newRouteId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[a-z2-7]{8}$/);
  const store = {version: 2, default_id: 'aaaaaaaa', routes: [{id: 'aaaaaaaa', label: 'G', provider: 'gemini', model: 'm', key_enc: 'v1:SECRET:x:y', key_last4: 'wxyz', fallback: true, updated_at: 1}]};
  const view = routesCore.publicRoutes(store);
  assert.deepEqual(view, {default_id: 'aaaaaaaa', routes: [{id: 'aaaaaaaa', label: 'G', provider: 'gemini', model: 'm', key_last4: 'wxyz', fallback: true}]});
  assert.ok(!JSON.stringify(view).includes('SECRET'));
});
