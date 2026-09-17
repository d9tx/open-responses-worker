import {
  GatewayError,
  Lifetime,
  readBody,
  type Settings,
} from '../utils/runtime';
import { parseRequest } from '../core/request';
import { responses, type UpstreamStreamFactory } from '../core/response';
import { eventStream } from '../core/stream';
import { getProvider } from '../providers';
import { runWorkersAI, type AiBinding } from '../providers/workers-ai';

export interface ResponsesEnv {
  AI: AiBinding;
  INFERENCE_ENABLED: string;
  INFERENCE_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

export async function prepareResponse(
  env: ResponsesEnv,
  body: unknown,
  limits: Settings,
  life: Lifetime,
  generate: boolean,
) {
  const parsed = parseRequest(body, limits, { allowEmptyInput: !generate });
  const provider = getProvider(parsed.model);
  const upstream = provider.normalizeRequest(parsed);

  if (generate) {
    if (env.INFERENCE_ENABLED !== 'true') {
      throw new GatewayError(
        503,
        'inference_disabled',
        'Inference is disabled until remote validation is authorized.',
      );
    }

    const admission = await life.wait(
      env.INFERENCE_RATE_LIMITER.limit({ key: 'self-use' }),
    );
    if (!admission.success) {
      throw new GatewayError(429, 'rate_limited', 'Inference request rate exceeded.');
    }
  }

  life.signal.throwIfAborted();

  const createUpstream: UpstreamStreamFactory = () =>
    runWorkersAI(env.AI, provider, upstream, life, limits);

  return { parsed, upstream, createUpstream };
}

export async function handleResponses(
  request: Request,
  env: ResponsesEnv,
  limits: Settings,
  requestId: string,
  headers: Record<string, string>,
): Promise<Response> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    'application/json'
  ) {
    throw new GatewayError(415, 'unsupported_media_type', 'Use application/json.');
  }

  const life = new Lifetime(request.signal, limits.timeout);
  try {
    const prepared = await prepareResponse(
      env,
      await readBody(request, limits.body, life),
      limits,
      life,
      true,
    );
    const events = responses(
      prepared.parsed,
      prepared.upstream,
      prepared.createUpstream,
      life,
      limits,
      requestId,
    );

    if (prepared.parsed.stream) {
      return new Response(eventStream(events, life), {
        headers: { ...headers, 'content-type': 'text/event-stream; charset=utf-8' },
      });
    }

    let result: unknown;
    for await (const event of events) {
      if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete'
      ) {
        result = event.response;
      }
    }
    if (!result) {
      throw new GatewayError(502, 'missing_response', 'No final response produced.');
    }
    return Response.json(result, { headers });
  } catch (error) {
    life.close();
    throw error;
  }
}
