export type Obj = Record<string, unknown>;

export class GatewayError extends Error {
  constructor(public status: number, public code: string, message: string, public retryable = false) {
    super(message);
  }
}
export function bad(message: string): never {
  throw new GatewayError(400, 'invalid_request', message);
}
export function object(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad('Expected an object.');
  return value as Obj;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') bad('Expected a string.');
  return value;
}
export function upstreamRecord(value: unknown): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream object.');
  }
  return value as Obj;
}
export function keys(value: Obj, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) bad(`Unsupported field: ${key}`);
}
export function failure(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError(502, 'upstream_error', 'Upstream request failed.');
}
export function errorBody(error: GatewayError) {
  return { error: { type: error.status < 500 ? 'invalid_request_error' : 'server_error', code: error.code, message: error.message, param: null } };
}
export const encoder = new TextEncoder();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export interface Settings {
  body: number; output: number; tool: number; schema: number; tools: number; tokens: number; timeout: number; idle: number;
}
export function settings(env: {
  MAX_BODY_BYTES: string;
  MAX_OUTPUT_BYTES: string;
  MAX_TOOL_BYTES: string;
  MAX_SCHEMA_BYTES: string;
  MAX_TOOLS: string;
  MAX_OUTPUT_TOKENS: string;
  REQUEST_TIMEOUT_MS: string;
  IDLE_TIMEOUT_MS: string;
}): Settings {
  const read = (key: keyof typeof env): number => {
    const n = Number(env[key]);

    if (!Number.isSafeInteger(n) || n < 1) {
      throw new GatewayError(
        503,
        'invalid_configuration',
        `Invalid limit: ${key}`,
      );
    }

    return n;
  };

  return {
    body: read('MAX_BODY_BYTES'),
    output: read('MAX_OUTPUT_BYTES'),
    tool: read('MAX_TOOL_BYTES'),
    schema: read('MAX_SCHEMA_BYTES'),
    tools: read('MAX_TOOLS'),
    tokens: read('MAX_OUTPUT_TOKENS'),
    timeout: read('REQUEST_TIMEOUT_MS'),
    idle: read('IDLE_TIMEOUT_MS'),
  };
}


// One deadline covers body reading, upstream attempts, backoff and downstream delivery.
export class Lifetime {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer: ReturnType<typeof setTimeout>;
  private onAbort: () => void;
  constructor(private parent: AbortSignal, timeout: number) {
    this.onAbort = () => this.controller.abort(new GatewayError(499, 'cancelled', 'Request cancelled.'));
    this.timer = setTimeout(() => this.controller.abort(new GatewayError(504, 'timeout', 'Request deadline exceeded.')), timeout);
    parent.addEventListener('abort', this.onAbort, { once: true });
    if (parent.aborted) this.onAbort();
  }
  async wait<T>(promise: Promise<T>, idle?: number): Promise<T> {
    this.signal.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', abort, { once: true });
      if (idle) timer = setTimeout(() => reject(new GatewayError(504, 'idle_timeout', 'Stream idle timeout.')), idle);
    });
    try { return await Promise.race([promise, stopped]); }
    finally { if (timer !== undefined) clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
  }
  async pause(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  close(): void { clearTimeout(this.timer); this.parent.removeEventListener('abort', this.onAbort); }
}
export async function readBody(request: Request, limit: number, life: Lifetime): Promise<unknown> {
  if (!request.body) bad('Request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await life.wait(reader.read(), 15000);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new GatewayError(413, 'body_too_large', 'Request exceeds body limit.');
      chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; }
  catch { return bad('Invalid UTF-8 JSON body.'); }
}
