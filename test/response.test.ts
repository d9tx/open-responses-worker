import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRequest } from '../src/core/request';
import { responses } from '../src/core/response';
import { glmProvider } from '../src/providers/glm';
import { runWorkersAI } from '../src/providers/workers-ai';
import type { ResponsesEvent } from '../src/core/types';
import { Lifetime } from '../src/utils/runtime';
import { delta, limits, sse, streamOf, toolCall } from './helpers';

const params = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };

async function run(body: Record<string, unknown>, upstreamBody: string) {
  const parsed = parseRequest({ model: 'glm-5.3', ...body }, limits);
  const upstream = glmProvider.normalizeRequest(parsed);
  const life = new Lifetime(new AbortController().signal, limits.timeout);
  let calls = 0;
  const ai = { run: async () => { calls++; return streamOf([upstreamBody]); } };
  const events: ResponsesEvent[] = [];
  let error: unknown;
  try {
    for await (const event of responses(
      parsed, upstream, () => runWorkersAI(ai, glmProvider, upstream, life, limits), life, limits, 'resp_test',
    )) events.push(event);
  } catch (e) {
    error = e;
  }
  return { events, calls, error };
}

const twoCalls = sse([
  delta({ tool_calls: [toolCall(0, 'f', '{"x":"1"}'), toolCall(1, 'f', '{"x":"2"}')] }, 'tool_calls'),
]);

test('multiple tool calls are emitted independently with parallel_tool_calls=true', async () => {
  const { events } = await run(
    { input: 'hi', stream: true, tools: [{ type: 'function', name: 'f', parameters: params }] },
    twoCalls,
  );
  const done = events.at(-1);
  assert.equal(done?.type, 'response.completed');
  const response = done?.response as { output: { call_id: string }[]; parallel_tool_calls: boolean };
  assert.equal(response.parallel_tool_calls, true);
  assert.equal(response.output.length, 2);
  assert.notEqual(response.output[0]?.call_id, response.output[1]?.call_id);
});

test('parallel_tool_calls=false rejects multiple generated calls after bounded retries', async () => {
  const { events, calls } = await run(
    {
      input: 'hi',
      stream: true,
      parallel_tool_calls: false,
      tools: [{ type: 'function', name: 'f', parameters: params }],
    },
    twoCalls,
  );
  assert.equal(calls, limits.attempts);
  assert.equal(events.at(-1)?.type, 'response.failed');
});

test('usage without cached tokens reports null details', async () => {
  const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 };
  const { events } = await run({ input: 'hi' }, sse([delta({ content: 'ok' }, 'stop', usage)]));
  const response = events.at(-1)?.response as { usage: Record<string, unknown> };
  assert.deepEqual(response.usage, {
    input_tokens: 5,
    input_tokens_details: null,
    output_tokens: 1,
    total_tokens: 6,
  });
});
