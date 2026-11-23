import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createModelChatHandler} from './model-chat.mjs';

const json = (res, code, data) => { res.writeHead(code, {'content-type': 'application/json'}); res.end(JSON.stringify(data)); };

async function setup({token, models} = {}) {
  const broker = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    broker.hits.push({method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString()});
    if (req.url.endsWith('/v1/models')) return json(res, 200, models || {object: 'list', default_id: 'aaaaaaaa', data: [
      {id: 'ghostwire', owned_by: 'ghost-wire'},
      {id: 'byok:aaaaaaaa', owned_by: 'user', label: 'Gemini', provider: 'gemini', model: 'gemini-3.5-flash-lite'},
      {id: 'byok:bbbbbbbb', owned_by: 'user', label: 'Broken', provider: 'openai', model: 'gpt-5', broken: true},
    ]});
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
  });
  broker.hits = [];
  broker.listen(0, '127.0.0.1'); await once(broker, 'listening');
  const config = {hostedWorkspace: true, workspaceMode: 'sidecar', modelChat: {url: `http://127.0.0.1:${broker.address().port}/model`, token}};
  const handler = createModelChatHandler(config, json);
  const server = http.createServer(async (req, res) => { if (!(await handler(req, res))) json(res, 418, {unhandled: true}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = {'x-ghostwire-mode': 'sidecar'}) => fetch(base + path, {method, headers: {'content-type': 'application/json', ...headers}, body: body && JSON.stringify(body)});
  return {broker, call, close: () => { server.close(); broker.close(); }};
}

test('lists only the saved keys, never Ghost Wire', async t => {
  const s = await setup(); t.after(s.close);
  const body = await (await s.call('GET', '/engine/model-chat/models')).json();
  assert.deepEqual(body, {default_id: 'aaaaaaaa', routes: [
    {id: 'byok:aaaaaaaa', label: 'Gemini', provider: 'gemini', model: 'gemini-3.5-flash-lite', broken: false},
    {id: 'byok:bbbbbbbb', label: 'Broken', provider: 'openai', model: 'gpt-5', broken: true},
  ]});
  assert.equal(s.broker.hits[0].url, '/model/v1/models');
});

test('streams a chat through the broker for a saved key, adding the token when configured', async t => {
  const s = await setup({token: 't'.repeat(40)}); t.after(s.close);
  const response = await s.call('POST', '/engine/model-chat/completions', {model: 'byok:aaaaaaaa', stream: true, messages: [{role: 'user', content: 'hi'}]});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.match(await response.text(), /Hel[\s\S]*lo[\s\S]*\[DONE\]/);
  assert.equal(s.broker.hits[0].url, '/model/v1/chat/completions');
  assert.equal(s.broker.hits[0].auth, 'Bearer ' + 't'.repeat(40));
  assert.equal(JSON.parse(s.broker.hits[0].body).model, 'byok:aaaaaaaa');
});

test('refuses anything but a saved key, so Ghost Wire chat stays on the billed path', async t => {
  const s = await setup(); t.after(s.close);
  for (const model of ['ghostwire', 'gpt-5', 'byok:BAD', undefined]) {
    const response = await s.call('POST', '/engine/model-chat/completions', {model, messages: []});
    assert.equal(response.status, 400, String(model));
    assert.equal((await response.json()).code, 'my_keys_only');
  }
  assert.equal(s.broker.hits.length, 0);
});

test('requires the workspace mode header and ignores other paths', async t => {
  const s = await setup(); t.after(s.close);
  assert.equal((await s.call('GET', '/engine/model-chat/models', undefined, {'x-ghostwire-mode': 'premium'})).status, 403);
  assert.equal((await s.call('GET', '/engine/tasks')).status, 418);
  assert.equal((await s.call('DELETE', '/engine/model-chat/models')).status, 404);
});

test('a broker that is down reports a clear error', async t => {
  const s = await setup(); s.broker.close(); s.broker.closeAllConnections(); t.after(s.close);
  const response = await s.call('POST', '/engine/model-chat/completions', {model: 'byok:aaaaaaaa', messages: []});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'workspace_offline');
});
