import {
  encoder,
  errorBody,
  failure,
  GatewayError,
  id,
  settings,
} from './utils/runtime';
import {
  GLM_MODELS_ETAG,
  glmCodexModelsResponse,
  glmProvider,
} from './providers/glm';
import { handleResponses, type ResponsesEnv } from './routes/responses';
import { upgradeResponses } from './routes/websocket';

type Env = Cloudflare.Env & ResponsesEnv & { GATEWAY_TOKEN?: string };

async function authenticate(request: Request, token: string | undefined): Promise<void> {
  if (!token || encoder.encode(token).length < 32) {
    throw new GatewayError(
      503,
      'missing_secret',
      'Configure a Gateway token of at least 32 bytes.',
    );
  }

  const auth = request.headers.get('authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.length > 4096) {
    throw new GatewayError(401, 'unauthorized', 'Invalid Gateway token.');
  }

  const digest = (value: string) => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [expected, actual] = await Promise.all([
    digest(token),
    digest(auth.slice(7)),
  ]);
  const a = new Uint8Array(expected);
  const b = new Uint8Array(actual);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  if (difference) throw new GatewayError(401, 'unauthorized', 'Invalid Gateway token.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = id('resp');
    const headers = { 'x-request-id': requestId, 'cache-control': 'no-store' };
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/health' && request.method === 'GET') {
        return Response.json({ status: 'ok' }, { headers });
      }
      if (!['/v1/models', '/v1/responses'].includes(path)) {
        throw new GatewayError(404, 'not_found', 'Unknown endpoint.');
      }

      const method = path === '/v1/models' ? 'GET' : 'POST';
      const websocket =
        path === '/v1/responses' &&
        request.method === 'GET' &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (request.method !== method && !websocket) {
        return Response.json(
          { error: { code: 'method_not_allowed', message: 'Method not allowed.' } },
          { status: 405, headers: { ...headers, allow: method } },
        );
      }

      await authenticate(request, env.GATEWAY_TOKEN);

      if (path === '/v1/models') {
        if (url.searchParams.has('client_version')) {
          if (env.INFERENCE_ENABLED !== 'true') {
            return Response.json({ models: [] }, { headers });
          }
          return Response.json(glmCodexModelsResponse(), {
            headers: { ...headers, 'x-models-etag': GLM_MODELS_ETAG },
          });
        }

        return Response.json(
          {
            object: 'list',
            data:
              env.INFERENCE_ENABLED === 'true'
                ? [
                    {
                      id: glmProvider.model.id,
                      object: 'model',
                      created: 0,
                      owned_by: 'cloudflare',
                    },
                  ]
                : [],
          },
          { headers },
        );
      }

      if (websocket) return upgradeResponses(env, settings(env), headers);
      return handleResponses(request, env, settings(env), requestId, headers);
    } catch (error) {
      const e = failure(error);
      return Response.json(errorBody(e), {
        status: e.status,
        headers: {
          ...headers,
          ...(e.status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;
