import test from 'node:test';
import assert from 'node:assert/strict';
import {createSignatureStore, PLACEHOLDER_SIGNATURE} from './gemini-signatures.mjs';

const call = (id, extra) => ({id, type: 'function', function: {name: 'Write', arguments: '{}'}, ...(extra ? {extra_content: extra} : {})});
const sig = value => ({google: {thought_signature: value}});

test('remembers signatures from a non-streaming reply and restores them on the next request', () => {
  const store = createSignatureStore();
  store.captureJson({choices: [{message: {role: 'assistant', tool_calls: [call('c1', sig('SIG-1')), call('c2', sig('SIG-2'))]}}]});
  const payload = {model: 'x', messages: [
    {role: 'user', content: 'hi'},
    {role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')]},
    {role: 'tool', tool_call_id: 'c1', content: 'ok'},
  ]};
  const restored = store.restore(payload);
  assert.deepEqual(restored.messages[1].tool_calls.map(c => c.extra_content), [sig('SIG-1'), sig('SIG-2')]);
  assert.equal(payload.messages[1].tool_calls[0].extra_content, undefined, 'input not mutated');
});

test('remembers signatures from a streamed reply split across chunks', () => {
  const store = createSignatureStore();
  const stream = store.sseCapture();
  const events = [
    {choices: [{delta: {role: 'assistant', tool_calls: [{index: 0, id: 'c9', type: 'function', function: {name: 'Write', arguments: ''}, extra_content: sig('STREAM-SIG')}]}}]},
    {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '{"a":1}'}}]}}]},
  ];
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  for (let i = 0; i < text.length; i += 17) stream.write(Buffer.from(text.slice(i, i + 17)));
  const restored = store.restore({messages: [{role: 'assistant', tool_calls: [call('c9')]}]});
  assert.deepEqual(restored.messages[0].tool_calls[0].extra_content, sig('STREAM-SIG'));
});

test('a signature that arrives on a later delta for the same index is still captured', () => {
  const store = createSignatureStore();
  const stream = store.sseCapture();
  stream.write(Buffer.from(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 1, id: 'late', function: {name: 'Read', arguments: ''}}]}}]})}\n\n`));
  stream.write(Buffer.from(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 1, extra_content: sig('LATE')}]}}]})}\n\n`));
  assert.deepEqual(store.restore({messages: [{role: 'assistant', tool_calls: [call('late')]}]}).messages[0].tool_calls[0].extra_content, sig('LATE'));
});

test('unknown tool calls get the documented placeholder; existing signatures are kept', () => {
  const store = createSignatureStore();
  const restored = store.restore({messages: [{role: 'assistant', tool_calls: [call('unknown'), call('kept', sig('OWN'))]}]});
  assert.deepEqual(restored.messages[0].tool_calls[0].extra_content, sig(PLACEHOLDER_SIGNATURE));
  assert.deepEqual(restored.messages[0].tool_calls[1].extra_content, sig('OWN'));
});

test('requests without tool calls pass through unchanged', () => {
  const store = createSignatureStore();
  const payload = {model: 'x', messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}]};
  assert.deepEqual(store.restore(payload), payload);
});

test('bad input never throws and memory stays bounded', () => {
  const store = createSignatureStore({max: 3});
  store.captureJson(null);
  store.captureJson({choices: 'nope'});
  const stream = store.sseCapture();
  stream.write(Buffer.from('data: {not json}\n\ndata: [DONE]\n\n'));
  for (let i = 0; i < 10; i++) store.captureJson({choices: [{message: {tool_calls: [call('id' + i, sig('S' + i))]}}]});
  assert.equal(store.size(), 3);
  assert.deepEqual(store.restore({messages: [{role: 'assistant', tool_calls: [call('id9')]}]}).messages[0].tool_calls[0].extra_content, sig('S9'));
  assert.deepEqual(store.restore({messages: [{role: 'assistant', tool_calls: [call('id0')]}]}).messages[0].tool_calls[0].extra_content, sig(PLACEHOLDER_SIGNATURE));
  assert.deepEqual(store.restore(null), null);
});
