import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createAccess} from './worker-access.mjs';

async function fake(name) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    server.hits.push({method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString()});
    res.writeHead(200, {'content-type': name === 'broker' ? 'text/event-stream' : 'application/json'});
    res.end(name === 'broker' ? 'data: {"x":1}\n\ndata: [DONE]\n\n' : JSON.stringify({from: name}));
  });
  server.hits = [];
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server;
}

async function setup(token = 's'.repeat(40)) {
  const worker = await fake('worker'), mining = await fake('mining'), broker = await fake('broker');
  const access = createAccess({
    WORKSPACE_MODEL_TOKEN: token,
    WORKER_HOST: '127.0.0.1', WORKER_PORT: String(worker.address().port),
    MINING_HOST: '127.0.0.1', MINING_PORT: String(mining.address().port),
    MODEL_BROKER_HOST: '127.0.0.1', MODEL_BROKER_PORT: String(broker.address().port),
  });
  access.listen(0, '127.0.0.1'); await once(access, 'listening');
  const base = `http://127.0.0.1:${access.address().port}`;
  const close = () => [worker, mining, broker, access].forEach(s => s.close());
  return {worker, mining, broker, base, close, token};
}

test('worker and mining routes behave as before', async t => {
  const s = await setup(); t.after(s.close);
  assert.deepEqual(await (await fetch(s.base + '/api/tasks', {headers: {authorization: 'Bearer user'}})).json(), {from: 'worker'});
  assert.equal(s.worker.hits[0].auth, 'Bearer user');
  assert.deepEqual(await (await fetch(s.base + '/mining')).json(), {from: 'mining'});
});

test('model chat goes to the broker with the workspace token, streaming through', async t => {
  const s = await setup(); t.after(s.close);
  const response = await fetch(s.base + '/model/v1/chat/completions', {method: 'POST', headers: {authorization: 'Bearer caller-supplied', 'content-type': 'application/json'},
    body: JSON.stringify({model: 'byok:abcdefgh', stream: true, messages: []})});
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(s.broker.hits[0].url, '/v1/chat/completions');
  assert.equal(s.broker.hits[0].auth, 'Bearer ' + s.token, 'caller auth is replaced by the workspace token');
  assert.equal(JSON.parse(s.broker.hits[0].body).model, 'byok:abcdefgh');
  await (await fetch(s.base + '/model/v1/models')).text();
  assert.equal(s.broker.hits[1].url, '/v1/models');
  assert.equal(s.worker.hits.length, 0);
});

test('only the two model endpoints are reachable, and only with a token configured', async t => {
  const s = await setup(); t.after(s.close);
  for (const [method, path] of [['GET', '/model/v1/chat/completions'], ['POST', '/model/v1/responses'], ['DELETE', '/model/v1/models'], ['GET', '/model/v1/models/extra'], ['GET', '/model']]) {
    const response = await fetch(s.base + path, {method});
    assert.equal(response.status, 404, `${method} ${path}`);
    await response.text();
  }
  assert.equal(s.broker.hits.length, 0);
  const none = await setup(''); t.after(none.close);
  const response = await fetch(none.base + '/model/v1/models');
  assert.equal(response.status, 404);
  assert.equal(none.broker.hits.length, 0);
});
