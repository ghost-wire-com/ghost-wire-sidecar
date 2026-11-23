// Shared by the gateway (save/test) and the workspace model broker (routing).
// Pure helpers only: no network, no logging of credentials.
import {readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';

export const ROUTE_FILE = 'route.private.json';
// v2: several saved keys with one default. Wins over ROUTE_FILE when present.
export const ROUTES_FILE = 'routes.private.json';
export const MAX_ROUTES = 12;
export const ROUTE_ID = /^[a-z2-7]{8}$/;
export const STATS_FILE = 'stats.json';
export const SOURCES = ['ghostwire', 'user-then-ghostwire', 'user'];

export function loadRegistry(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const registry = new Map();
  for (const entry of raw.providers || []) {
    const url = new URL(entry.base_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || entry.base_url.endsWith('/')) throw Error('Invalid provider base URL');
    if (!/^[a-z0-9-]{1,32}$/.test(entry.id) || registry.has(entry.id) || !['bearer', 'anthropic'].includes(entry.models_auth)) throw Error('Invalid provider entry');
    registry.set(entry.id, {id: entry.id, name: String(entry.name), base_url: entry.base_url, models_auth: entry.models_auth,
      key_pattern: entry.key_pattern ? new RegExp(entry.key_pattern) : null, enabled: entry.enabled !== false});
  }
  return registry;
}

export function loadFilter(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return {deny: Array.isArray(raw.deny) ? raw.deny.map(String) : [], allow_only: raw.allow_only && typeof raw.allow_only === 'object' ? raw.allow_only : {},
    min_context_tokens: Number.isFinite(raw.min_context_tokens) ? raw.min_context_tokens : 0};
}

const glob = pattern => new RegExp('^' + pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

export function modelAllowed(filter, providerId, model, contextTokens) {
  const subject = providerId + '/' + model;
  if (filter.deny.some(pattern => glob(pattern).test(subject) || glob(pattern).test(model))) return false;
  const only = filter.allow_only[providerId];
  if (Array.isArray(only) && only.length && !only.some(pattern => glob(pattern).test(model))) return false;
  if (Number.isFinite(contextTokens) && filter.min_context_tokens && contextTokens < filter.min_context_tokens) return false;
  return true;
}

// Pasted keys often carry a trailing space or line break; never let that fail a real key.
export const normalizeKey = key => (typeof key === 'string' ? key.trim() : key);

export function validateKey(provider, key) {
  if (typeof key !== 'string') return {ok: false, code: 'invalid_key_format'};
  if (/^sk-ant-oat/i.test(key) || /^eyJ[\w-]*\.[\w-]+\./.test(key)) return {ok: false, code: 'subscription_token'};
  if (key.length < 20 || key.length > 512 || !/^[\x21-\x7e]+$/.test(key) || key.includes(';')) return {ok: false, code: 'invalid_key_format'};
  if (provider.key_pattern && !provider.key_pattern.test(key)) return {ok: false, code: 'invalid_key_format'};
  return {ok: true};
}

export const validateModelId = model => typeof model === 'string' && /^[A-Za-z0-9._:/@-]{1,128}$/.test(model);

export function readMasterKey(file) {
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw Error('Invalid model route master key');
  return key;
}

export function encryptKey(master, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv);
  const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decryptKey(master, blob) {
  const [version, iv, tag, data] = String(blob).split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw Error('Invalid encrypted key');
  const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export function readRoute(dir) {
  try { return JSON.parse(readFileSync(join(dir, ROUTE_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function writeRoute(dir, route) {
  const file = join(dir, ROUTE_FILE), temporary = file + '.tmp';
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(route)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
}

export function modelIds(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
  return [...new Set(list.map(item => item?.id).filter(id => validateModelId(id)))].sort().slice(0, 500);
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const base32 = bytes => { let bits = 0, value = 0, out = ''; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } } return out; };
export const newRouteId = () => base32(randomBytes(5));
// Migrated v1 routes get an id derived from their encrypted key, so it stays the same across reads.
const migratedId = route => base32(createHash('sha256').update(String(route.key_enc)).digest().subarray(0, 5));

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function readRoutes(dir) {
  const stored = readJson(join(dir, ROUTES_FILE));
  if (stored?.version === 2 && Array.isArray(stored.routes)) return stored;
  const old = readRoute(dir);
  if (!old?.key_enc || !old.provider || !old.model) return {version: 2, default_id: 'ghostwire', routes: []};
  const route = {id: migratedId(old), label: '', provider: old.provider, model: old.model, key_enc: old.key_enc, key_last4: old.key_last4 || '',
    fallback: old.source !== 'user', updated_at: old.updated_at || 0};
  return {version: 2, default_id: old.source === 'ghostwire' ? 'ghostwire' : route.id, routes: [route]};
}

export function writeRoutes(dir, store) {
  const ids = new Set();
  if (store?.version !== 2 || !Array.isArray(store.routes) || store.routes.length > MAX_ROUTES) throw Error('Invalid route store');
  for (const route of store.routes) {
    if (!ROUTE_ID.test(route?.id) || ids.has(route.id) || !route.provider || !validateModelId(route.model) || !route.key_enc) throw Error('Invalid route entry');
    ids.add(route.id);
  }
  if (store.default_id !== 'ghostwire' && !ids.has(store.default_id)) throw Error('Default route does not exist');
  const file = join(dir, ROUTES_FILE), temporary = file + '.tmp';
  const descriptor = openSync(temporary, 'w', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(store)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
  // Keep the single-route file in step so an older broker still serves the default.
  const chosen = store.routes.find(route => route.id === store.default_id);
  const shown = chosen || store.routes[0];
  if (!shown) { rmSync(join(dir, ROUTE_FILE), {force: true}); return; }
  const source = !chosen ? 'ghostwire' : chosen.fallback ? 'user-then-ghostwire' : 'user';
  writeRoute(dir, {version: 1, source, provider: shown.provider, model: shown.model, key_enc: shown.key_enc, key_last4: shown.key_last4, updated_at: shown.updated_at});
}

export function publicRoutes(store) {
  return {default_id: store.default_id, routes: store.routes.map(({id, label, provider, model, key_last4, fallback}) => ({id, label, provider, model, key_last4, fallback}))};
}
