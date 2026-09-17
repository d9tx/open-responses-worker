import {
  encoder,
  failure,
  GatewayError,
  type Obj,
  type Settings,
  Lifetime,
} from '../utils/runtime';
import { matches } from '../utils/schema';
import type {
  NormalizedChunk,
  NormalizedFinishReason,
  ProviderAdapter,
  UpstreamRequest,
} from './types';

export interface AiBinding {
  run(
    model: string,
    input: unknown,
    options?: {
      extraHeaders?: Record<string, string>;
    },
  ): Promise<unknown>;
}

function providerError(provider: ProviderAdapter, error: unknown): GatewayError {
  const normalized = provider.normalizeError?.(error);
  if (normalized) {
    return new GatewayError(
      normalized.status,
      normalized.code,
      normalized.message,
      normalized.retryable,
    );
  }
  return failure(error);
}

async function* sse(
  source: ReadableStream<Uint8Array>,
  life: Lifetime,
  limits: { idle: number; output: number },
): AsyncGenerator<string> {
  const reader = source.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  life.signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let pending = '';
  let data: string[] = [];
  let eventBytes = 0;
  let wireBytes = 0;

  try {
    while (true) {
      const { value, done } = await life.wait(reader.read(), limits.idle);
      if (done) {
        life.signal.throwIfAborted();
        if (pending || data.length) {
          throw new GatewayError(502, 'truncated_stream', 'Upstream SSE frame was truncated.');
        }
        break;
      }

      wireBytes += value.byteLength;
      if (wireBytes > limits.output * 8) {
        throw new GatewayError(502, 'output_limit', 'Upstream wire limit exceeded.');
      }

      pending += decoder.decode(value, { stream: true });
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i];
        if (c !== '\n' && c !== '\r') continue;
        if (c === '\r' && i === pending.length - 1) break;

        const line = pending.slice(start, i);
        if (c === '\r' && pending[i + 1] === '\n') i++;
        start = i + 1;

        if (line === '') {
          if (data.length) yield data.join('\n');
          data = [];
          eventBytes = 0;
        } else if (line.startsWith('data:')) {
          const payload = line.slice(line[5] === ' ' ? 6 : 5);
          eventBytes += encoder.encode(payload).length;
          if (eventBytes > limits.output) {
            throw new GatewayError(502, 'output_limit', 'Upstream SSE event exceeds limit.');
          }
          data.push(payload);
        }
      }

      pending = pending.slice(start);
      if (pending.length > limits.output) {
        throw new GatewayError(502, 'output_limit', 'Upstream SSE line exceeds limit.');
      }
    }

    decoder.decode();
  } finally {
    life.signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateStructuredOutput(
  value: unknown,
  schema: Obj,
  outputLimit: number,
): string {
  if (value === undefined) {
    throw new GatewayError(502, 'invalid_upstream', 'Structured output is missing.');
  }
  if (!matches(value, schema)) {
    throw new GatewayError(
      502,
      'invalid_upstream',
      'Structured output does not match the declared schema.',
    );
  }
  const text = JSON.stringify(value);
  if (encoder.encode(text).length > outputLimit) {
    throw new GatewayError(502, 'output_limit', 'Structured output exceeds limit.');
  }
  return text;
}

export async function* runWorkersAI(
  ai: AiBinding,
  provider: ProviderAdapter,
  request: UpstreamRequest,
  life: Lifetime,
  limits: Settings,
): AsyncGenerator<NormalizedChunk> {
  let source: unknown;
  try {
    const result = ai.run(request.model, request.input, request.options);
    // AI.run currently has no proven abort contract. Cancel a late stream
    // instead of leaking its reader.
    void result.then(
      value => {
        if (life.signal.aborted && value instanceof ReadableStream) {
          void value.cancel().catch(() => {});
        }
      },
      () => {},
    );
    source = await life.wait(result);
  } catch (error) {
    throw providerError(provider, error);
  }

  if (request.structuredSchema !== undefined) {
    let chunk: NormalizedChunk;
    try {
      chunk = provider.normalizeChunk(source);
    } catch (error) {
      throw providerError(provider, error);
    }
    const text = validateStructuredOutput(
      chunk.structuredValue,
      request.structuredSchema,
      limits.output,
    );
    yield {
      text,
      finish: chunk.finish ?? 'stop',
      ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
    };
    return;
  }

  if (!(source instanceof ReadableStream)) {
    throw new GatewayError(502, 'invalid_upstream', 'Expected Workers AI SSE stream.');
  }

  let finish: NormalizedFinishReason | undefined;
  let done = false;
  try {
    for await (const payload of sse(source as ReadableStream<Uint8Array>, life, limits)) {
      if (payload === '[DONE]') {
        done = true;
        break;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(payload) as unknown;
      } catch {
        throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream SSE JSON.');
      }

      let chunk: NormalizedChunk;
      try {
        chunk = provider.normalizeChunk(raw);
      } catch (error) {
        throw providerError(provider, error);
      }

      if (
        finish !== undefined &&
        (chunk.text !== undefined ||
          chunk.reasoning !== undefined ||
          (chunk.toolCalls?.length ?? 0) > 0)
      ) {
        throw new GatewayError(502, 'invalid_upstream', 'Content received after finish reason.');
      }
      if (chunk.finish !== undefined) {
        if (finish !== undefined) {
          throw new GatewayError(502, 'invalid_upstream', 'Duplicate upstream finish reason.');
        }
        finish = chunk.finish;
      }
      yield chunk;
    }

    if (!done || finish === undefined) {
      throw new GatewayError(502, 'truncated_stream', 'Upstream ended without a complete terminal signal.');
    }
    yield { finish };
  } catch (error) {
    throw providerError(provider, error);
  }
}
