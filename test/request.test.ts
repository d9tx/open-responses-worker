import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequest } from '../src/core/request';
import { glmProvider } from '../src/providers/glm';
import { limits } from './helpers';

const params = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };

test('parallel_tool_calls defaults to true and is preserved when false', () => {
  assert.equal(parseRequest({ model: 'glm-5.3', input: 'hi' }, limits).parallelToolCalls, true);
  assert.equal(
    parseRequest({ model: 'glm-5.3', input: 'hi', parallel_tool_calls: false }, limits).parallelToolCalls,
    false,
  );
});

test('duplicate tool names are rejected per namespace', () => {
  assert.throws(
    () => parseRequest({
      model: 'glm-5.3',
      input: 'hi',
      tools: [
        { type: 'function', name: 'f', parameters: params },
        { type: 'function', name: 'f', parameters: params },
      ],
    }, limits),
    /Duplicate tool name/,
  );
});

test('historical tool calls are paired with results', () => {
  const parsed = parseRequest({
    model: 'glm-5.3',
    tools: [{ type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'f', parameters: params }] }],
    input: [
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'f', namespace: 'ns', arguments: '{"x":"1"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  }, limits);
  assert.equal(parsed.history[1]?.toolCalls?.[0]?.namespace, 'ns');
  assert.equal(parsed.history[2]?.toolCallId, 'c1');
  assert.throws(
    () => parseRequest({
      model: 'glm-5.3',
      tools: [{ type: 'function', name: 'f', parameters: params }],
      input: [{ type: 'function_call_output', call_id: 'c9', output: 'ok' }],
    }, limits),
    /Orphaned/,
  );
});

test('namespaced tool colliding with a plain tool name gets a reversible alias', () => {
  const parsed = parseRequest({
    model: 'glm-5.3',
    input: 'hi',
    tools: [
      { type: 'function', name: 'a__b', parameters: params },
      { type: 'namespace', name: 'a', tools: [{ type: 'function', name: 'b', parameters: params }] },
    ],
  }, limits);
  const upstream = glmProvider.normalizeRequest(parsed);
  assert.equal(upstream.toolMap.size, 2);
  assert.equal(upstream.toolMap.get('a__b')?.namespace, undefined);
  const alias = [...upstream.toolMap].find(([, tool]) => tool.namespace === 'a')?.[0];
  assert.match(alias ?? '', /^gateway_tool_\d+$/);
});
