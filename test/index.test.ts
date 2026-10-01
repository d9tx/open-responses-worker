import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index';

const token = 'test-gateway-token-0123456789abcdef0123';

function env(inference: 'true' | 'false') {
  return {
    GATEWAY_TOKEN: token,
    INFERENCE_ENABLED: inference,
    MAX_BODY_BYTES: '1048576',
    MAX_OUTPUT_BYTES: '65536',
    MAX_TOOL_BYTES: '16384',
    MAX_SCHEMA_BYTES: '65536',
    MAX_TOOLS: '32',
    MAX_OUTPUT_TOKENS: '1024',
    REQUEST_TIMEOUT_MS: '5000',
    IDLE_TIMEOUT_MS: '5000',
    BODY_IDLE_TIMEOUT_MS: '5000',
    MAX_ATTEMPTS: '3',
    WS_MAX_CONNECTION_BYTES: '1048576',
    WS_MAX_CONNECTION_MS: '60000',
    AI: {
      run: async () => {
        throw new Error('AI must not be called');
      },
    },
    INFERENCE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

function post(body: string, contentType = 'application/json'): Request {
  return new Request('https://gateway.test/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body,
  });
}

async function call(request: Request, inference: 'true' | 'false' = 'false') {
  const fetch = worker.fetch as (request: Request, env: unknown) => Promise<Response>;
  const response = await fetch(request, env(inference));
  const body = (await response.json()) as { error?: { code?: unknown } };
  return { status: response.status, code: body.error?.code };
}

test('HTTP responses errors are returned as JSON instead of escaping fetch', async () => {
  const disabled = await call(post(JSON.stringify({ model: 'glm-5.3', input: 'hi' })));
  assert.deepEqual(disabled, { status: 503, code: 'inference_disabled' });

  const mediaType = await call(post('{}', 'text/plain'));
  assert.deepEqual(mediaType, { status: 415, code: 'unsupported_media_type' });

  const invalid = await call(post('not json'), 'true');
  assert.equal(invalid.status, 400);
});
