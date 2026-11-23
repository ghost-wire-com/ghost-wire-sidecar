import test from 'node:test';
import assert from 'node:assert/strict';
import {createReplyStore, adaptRequest, PLACEHOLDER_SIGNATURE} from './provider-adapters.mjs';

const call = (id, extra) => ({id, type: 'function', function: {name: 'Write', arguments: '{}'}, ...(extra ? {extra_content: extra} : {})});
const sig = value => ({google: {thought_signature: value}});
const sse = events => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
const feed = (store, text, size = 17) => { const s = store.sseCapture(); for (let i = 0; i < text.length; i += size) s.write(Buffer.from(text.slice(i, i + size))); };

// ---- Gemini thought signatures -------------------------------------------------

test('gemini: signatures from a non-streaming reply are restored on the next request', () => {
  const store = createReplyStore();
  store.captureJson({choices: [{message: {role: 'assistant', tool_calls: [call('c1', sig('SIG-1')), call('c2', sig('SIG-2'))]}}]});
  const payload = {model: 'x', messages: [{role: 'user', content: 'hi'}, {role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')]}, {role: 'tool', tool_call_id: 'c1', content: 'ok'}]};
  const restored = store.restore('gemini', payload);
  assert.deepEqual(restored.messages[1].tool_calls.map(c => c.extra_content), [sig('SIG-1'), sig('SIG-2')]);
  assert.equal(payload.messages[1].tool_calls[0].extra_content, undefined, 'input not mutated');
});

test('gemini: signatures from a streamed reply split across chunks, with or without index', () => {
  const store = createReplyStore();
  feed(store, sse([
    {choices: [{delta: {role: 'assistant', tool_calls: [{index: 0, id: 'c9', type: 'function', function: {name: 'Write', arguments: ''}, extra_content: sig('STREAM-SIG')}]}}]},
    {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '{"a":1}'}}]}}]},
    {choices: [{delta: {tool_calls: [{id: 'noindex', type: 'function', function: {name: 'Read', arguments: '{}'}, extra_content: sig('NO-INDEX')}]}}]},
  ]));
  const restored = store.restore('gemini', {messages: [{role: 'assistant', tool_calls: [call('c9'), call('noindex')]}]});
  assert.deepEqual(restored.messages[0].tool_calls.map(c => c.extra_content), [sig('STREAM-SIG'), sig('NO-INDEX')]);
});

test('gemini: unknown tool calls get the documented placeholder; existing signatures are kept', () => {
  const restored = createReplyStore().restore('gemini', {messages: [{role: 'assistant', tool_calls: [call('unknown'), call('kept', sig('OWN'))]}]});
  assert.deepEqual(restored.messages[0].tool_calls[0].extra_content, sig(PLACEHOLDER_SIGNATURE));
  assert.deepEqual(restored.messages[0].tool_calls[1].extra_content, sig('OWN'));
  assert.equal(PLACEHOLDER_SIGNATURE, 'skip_thought_signature_validator');
});

// ---- DeepSeek reasoning_content -------------------------------------------------

test('deepseek: reasoning_content is echoed for tool turns and plain turns', () => {
  const store = createReplyStore();
  store.captureJson({choices: [{message: {role: 'assistant', content: null, reasoning_content: 'think A', tool_calls: [call('d1')]}}]});
  feed(store, sse([
    {choices: [{delta: {role: 'assistant', reasoning_content: 'think '}}]},
    {choices: [{delta: {reasoning_content: 'B'}}]},
    {choices: [{delta: {content: 'Final '}}]},
    {choices: [{delta: {content: 'answer'}, finish_reason: 'stop'}]},
  ]));
  const payload = {tools: [{type: 'function', function: {name: 'Write'}}], messages: [
    {role: 'user', content: 'go'},
    {role: 'assistant', content: null, tool_calls: [call('d1')]},
    {role: 'tool', tool_call_id: 'd1', content: 'ok'},
    {role: 'assistant', content: 'Final answer'},
    {role: 'user', content: 'again'},
  ]};
  const restored = store.restore('deepseek', payload);
  assert.equal(restored.messages[1].reasoning_content, 'think A');
  assert.equal(restored.messages[3].reasoning_content, 'think B');
});

test('deepseek: unknown assistant turns get an empty reasoning_content only when tools are sent', () => {
  const store = createReplyStore();
  const withTools = store.restore('deepseek', {tools: [{type: 'function', function: {name: 'x'}}], messages: [{role: 'assistant', content: 'old'}]});
  assert.equal(withTools.messages[0].reasoning_content, '');
  const without = store.restore('deepseek', {messages: [{role: 'assistant', content: 'old'}]});
  assert.equal(without.messages[0].reasoning_content, undefined);
});

// ---- OpenRouter reasoning_details ------------------------------------------------

test('openrouter: reasoning_details are echoed unchanged (non-streaming) and merged (streaming)', () => {
  const store = createReplyStore();
  const details = [{type: 'reasoning.encrypted', data: 'ENC', index: 0}];
  store.captureJson({choices: [{message: {role: 'assistant', content: null, reasoning_details: details, tool_calls: [call('o1')]}}]});
  feed(store, sse([
    {choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'part 1 ', index: 0}]}}]},
    {choices: [{delta: {reasoning_details: [{type: 'reasoning.text', text: 'part 2', index: 0}], tool_calls: [{index: 0, id: 'o2', type: 'function', function: {name: 'Read', arguments: '{}'}}]}}]},
  ]));
  const restored = store.restore('openrouter', {messages: [{role: 'assistant', tool_calls: [call('o1')]}, {role: 'assistant', tool_calls: [call('o2')]}]});
  assert.deepEqual(restored.messages[0].reasoning_details, details);
  assert.deepEqual(restored.messages[1].reasoning_details, [{type: 'reasoning.text', text: 'part 1 part 2', index: 0}]);
});

// ---- Request rules -----------------------------------------------------------------

test('mistral: tool-call ids become 9 alphanumerics consistently; required becomes any', () => {
  const payload = {tool_choice: 'required', messages: [
    {role: 'assistant', tool_calls: [call('call_abc-123_long'), call('ABCDEF123')]},
    {role: 'tool', tool_call_id: 'call_abc-123_long', content: 'ok'},
    {role: 'tool', tool_call_id: 'ABCDEF123', content: 'ok'},
  ]};
  const out = adaptRequest('mistral', payload);
  const mapped = out.messages[0].tool_calls[0].id;
  assert.match(mapped, /^[a-zA-Z0-9]{9}$/);
  assert.equal(out.messages[1].tool_call_id, mapped);
  assert.equal(out.messages[0].tool_calls[1].id, 'ABCDEF123', 'valid ids are kept');
  assert.equal(out.messages[2].tool_call_id, 'ABCDEF123');
  assert.equal(adaptRequest('mistral', payload).messages[0].tool_calls[0].id, mapped, 'deterministic');
  assert.equal(out.tool_choice, 'any');
  assert.equal(payload.tool_choice, 'required', 'input not mutated');
});

test('anthropic: drops sampling fields it rejects, forces n=1, and never forces a tool', () => {
  const out = adaptRequest('anthropic', {temperature: 0.2, top_p: 0.9, n: 3, tool_choice: {type: 'function', function: {name: 'Write'}}, messages: []});
  assert.equal(out.temperature, undefined);
  assert.equal(out.top_p, undefined);
  assert.equal(out.n, 1);
  assert.equal(out.tool_choice, 'auto');
  assert.equal(adaptRequest('anthropic', {tool_choice: 'required', messages: []}).tool_choice, 'auto');
  assert.equal(adaptRequest('anthropic', {tool_choice: 'none', messages: []}).tool_choice, 'none');
});

test('other providers pass through untouched', () => {
  const payload = {temperature: 0.2, tool_choice: 'required', messages: [{role: 'assistant', tool_calls: [call('call_long-id')]}]};
  for (const id of ['openai', 'groq', 'together', 'xai', 'gemini', 'deepseek', 'openrouter']) assert.deepEqual(adaptRequest(id, payload), payload, id);
  const store = createReplyStore();
  for (const id of ['openai', 'groq', 'together', 'xai', 'mistral', 'anthropic']) assert.deepEqual(store.restore(id, payload), payload, id);
});

test('bad input never throws and memory stays bounded', () => {
  const store = createReplyStore({max: 3});
  store.captureJson(null);
  store.captureJson({choices: 'nope'});
  store.sseCapture().write(Buffer.from('data: {not json}\n\ndata: [DONE]\n\n'));
  for (let i = 0; i < 10; i++) store.captureJson({choices: [{message: {tool_calls: [call('id' + i, sig('S' + i))]}}]});
  assert.equal(store.size(), 3);
  assert.deepEqual(store.restore('gemini', {messages: [{role: 'assistant', tool_calls: [call('id9')]}]}).messages[0].tool_calls[0].extra_content, sig('S9'));
  assert.deepEqual(store.restore('gemini', null), null);
  assert.deepEqual(adaptRequest('mistral', null), null);
});

test('gemini: drops sampling fields its OpenAI endpoint rejects, keeps the rest', () => {
  const payload = {model: 'm', temperature: 0.7, top_p: 0.9, max_tokens: 100, stream: true, frequency_penalty: 0, presence_penalty: 0.1, logit_bias: {}, logprobs: false, top_logprobs: 2, messages: []};
  const out = adaptRequest('gemini', payload);
  for (const field of ['frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs']) assert.equal(out[field], undefined, field);
  assert.deepEqual([out.temperature, out.top_p, out.max_tokens, out.stream], [0.7, 0.9, 100, true]);
  assert.equal(payload.frequency_penalty, 0, 'input not mutated');
});
