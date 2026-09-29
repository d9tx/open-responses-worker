import type { Settings } from '../src/utils/runtime';

export const limits: Settings = {
  body: 1 << 20,
  output: 1 << 16,
  tool: 1 << 14,
  schema: 1 << 16,
  tools: 32,
  tokens: 1024,
  timeout: 5_000,
  idle: 5_000,
  bodyIdle: 5_000,
  attempts: 3,
  wsBytes: 1 << 20,
  wsLifetime: 60_000,
};

export const encoder = new TextEncoder();

export function streamOf(packets: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const packet of packets) {
        controller.enqueue(typeof packet === 'string' ? encoder.encode(packet) : packet);
      }
      controller.close();
    },
  });
}

export function sse(events: unknown[]): string {
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
}

export function delta(value: Record<string, unknown>, finish?: string, usage?: unknown) {
  return {
    choices: [{ index: 0, delta: value, ...(finish ? { finish_reason: finish } : {}) }],
    ...(usage ? { usage } : {}),
  };
}

export function toolCall(index: number, name: string, args: string) {
  return { index, id: `c${index}`, type: 'function', function: { name, arguments: args } };
}
