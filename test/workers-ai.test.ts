import assert from 'node:assert/strict';
import test from 'node:test';
import { glmProvider } from '../src/providers/glm';
import { runWorkersAI } from '../src/providers/workers-ai';
import type { NormalizedChunk } from '../src/providers/types';
import { Lifetime } from '../src/utils/runtime';
import { delta, encoder, limits, sse, streamOf } from './helpers';

async function collect(packets: (string | Uint8Array)[]): Promise<NormalizedChunk[]> {
  const life = new Lifetime(new AbortController().signal, limits.timeout);
  const ai = { run: async () => streamOf(packets) };
  const request = { model: 'm', input: {}, stream: true, toolMap: new Map() };
  const chunks: NormalizedChunk[] = [];
  try {
    for await (const chunk of runWorkersAI(ai, glmProvider, request, life, limits)) chunks.push(chunk);
  } finally {
    life.close();
  }
  return chunks;
}

function text(chunks: NormalizedChunk[]): string {
  return chunks.map(chunk => chunk.text ?? '').join('');
}

test('SSE records split one byte at a time, including multi-byte UTF-8', async () => {
  const body = sse([delta({ content: '你好😀' }), delta({ content: '!' }, 'stop')]);
  const bytes = encoder.encode(body);
  const packets = [...bytes].map(byte => Uint8Array.of(byte));
  const chunks = await collect(packets);
  assert.equal(text(chunks), '你好😀!');
  assert.equal(chunks.at(-1)?.finish, 'stop');
});

test('CRLF terminators split between packets', async () => {
  const body = sse([delta({ content: 'a' }), delta({ content: 'b' }, 'stop')]).replaceAll('\n', '\r\n');
  const packets: string[] = [];
  for (const piece of body.split('\r')) packets.push(piece, '\r');
  packets.pop();
  assert.equal(text(await collect(packets)), 'ab');
});

test('long line delivered in many packets', async () => {
  const long = 'x'.repeat(20_000);
  const body = sse([delta({ content: long }, 'stop')]);
  const packets: string[] = [];
  for (let i = 0; i < body.length; i += 7) packets.push(body.slice(i, i + 7));
  assert.equal(text(await collect(packets)), long);
});

test('EOF without [DONE] is not a successful completion', async () => {
  const body = `data: ${JSON.stringify(delta({ content: 'a' }, 'stop'))}\n\n`;
  await assert.rejects(collect([body]), { code: 'truncated_stream' });
});

test('missing cached token count stays unknown', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  const chunks = await collect([sse([delta({ content: 'a' }, 'stop', usage)])]);
  const reported = chunks.find(chunk => chunk.usage)?.usage;
  assert.deepEqual(reported, { inputTokens: 10, outputTokens: 2 });
});
