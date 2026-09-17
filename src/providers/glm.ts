import { GatewayError, upstreamRecord, type Obj } from '../utils/runtime';
import {
  codexModelsResponse as buildCodexModelsResponse,
} from '../utils/model-info';
import type {
  HistoryMessage,
  ModelDescriptor,
  NormalizedChunk,
  NormalizedError,
  NormalizedFinishReason,
  NormalizedToolCallDelta,
  NormalizedUsage,
  ProviderAdapter,
  ResponsesRequest,
  ResponsesTool,
  ToolChoice,
  UpstreamRequest,
} from './types';

const GLM_MODEL: ModelDescriptor = {
  id: 'glm-5.3',
  aliases: ['glm-5.3', '@cf/zai-org/glm-5.3', 'codex-auto-review'],
  context: 1_048_576,
  displayName: 'GLM-5.3',
  description:
    'Cloudflare Workers AI GLM-5.3 through the local Responses gateway.',
};

const UPSTREAM_MODEL = '@cf/zai-org/glm-5.3';
export const GLM_MODELS_ETAG = '"codex-0.154.0-glm-5.3-v1"';

function field(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream text.');
  }
  return value;
}

function normalizeFinishReason(value: unknown): NormalizedFinishReason {
  if (value === 'stop' || value === 'tool_calls' || value === 'length') return value;
  throw new GatewayError(502, 'invalid_upstream', 'Unsupported finish reason.');
}

function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  const usage = upstreamRecord(raw);
  const input = usage.prompt_tokens;
  const output = usage.completion_tokens;
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  ) {
    return undefined;
  }

  const details =
    usage.prompt_tokens_details === null ||
    typeof usage.prompt_tokens_details !== 'object' ||
    Array.isArray(usage.prompt_tokens_details)
      ? undefined
      : usage.prompt_tokens_details as Obj;
  const cached = details?.cached_tokens;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens:
      typeof cached === 'number' &&
      Number.isSafeInteger(cached) &&
      cached >= 0
        ? cached
        : 0,
  };
}

function normalizeToolCall(raw: unknown): NormalizedToolCallDelta {
  const call = upstreamRecord(raw);

  // GLM continuation chunks may omit index or send null. Missing means slot 0.
  const index = call.index == null ? 0 : call.index;
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream tool-call index.');
  }

  // type may also be absent, null, or empty in continuation chunks.
  if (call.type != null && call.type !== '' && call.type !== 'function') {
    throw new GatewayError(502, 'invalid_upstream', 'Unsupported upstream tool-call type.');
  }

  const fn = call.function == null ? {} : upstreamRecord(call.function);
  const nestedName =
    typeof fn.name === 'string' && fn.name !== '' ? fn.name : undefined;
  const flatName =
    typeof call.name === 'string' && call.name !== '' ? call.name : undefined;
  const name = nestedName ?? flatName;
  if (name !== undefined && name.length > 64) {
    throw new GatewayError(502, 'invalid_upstream', 'Upstream tool name exceeds limit.');
  }

  // GLM emits nested OpenAI-style calls, while some Workers AI adapters flatten
  // the same fields. Both are accepted here and reduced to one normalized shape.
  const args = fn.arguments != null ? fn.arguments : call.arguments;
  if (args !== undefined && args !== null && typeof args !== 'string') {
    throw new GatewayError(502, 'invalid_arguments', 'Upstream arguments must be a string.');
  }

  return {
    index,
    ...(name === undefined ? {} : { name }),
    ...(args === undefined || args === null ? {} : { arguments: args }),
  };
}

function isUsageTrailer(event: Obj, usage: NormalizedUsage | undefined): boolean {
  if (Object.keys(event).some(key => key !== 'response' && key !== 'usage')) return false;
  if (event.response !== undefined && event.response !== '') return false;
  if (!usage) return false;
  const total = (event.usage as Obj).total_tokens;
  return (
    typeof total === 'number' &&
    Number.isSafeInteger(total) &&
    total >= 0
  );
}

function toolWireName(tool: ResponsesTool): string {
  return tool.namespace === undefined
    ? tool.name
    : `${tool.namespace}__${tool.name}`;
}

function toolIdentity(name: string, namespace?: string): string {
  return `${namespace ?? ''}\0${name}`;
}

function assignWireNames(tools: readonly ResponsesTool[]): Map<string, ResponsesTool> {
  const toolMap = new Map<string, ResponsesTool>();
  const used = new Set<string>();

  for (const tool of tools) {
    const full = toolWireName(tool);
    used.add(full);
  }

  // GLM rejects function names longer than 64 bytes. Long namespace-expanded
  // names get deterministic, request-local aliases; the map is reversible.
  let aliasIndex = 0;
  const longTools = tools
    .filter(tool => toolWireName(tool).length > 64)
    .sort((a, b) => {
      const left = toolWireName(a);
      const right = toolWireName(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });

  for (const tool of longTools) {
    let alias: string;
    do {
      alias = `gateway_tool_${aliasIndex++}`;
    } while (used.has(alias));
    used.add(alias);
    toolMap.set(alias, tool);
  }

  for (const tool of tools) {
    const full = toolWireName(tool);
    if (full.length <= 64) toolMap.set(full, tool);
  }

  return toolMap;
}

function upstreamToolChoice(
  choice: ToolChoice,
  tools: readonly ResponsesTool[],
  wireNames: ReadonlyMap<ResponsesTool, string>,
): unknown {
  if (typeof choice !== 'object') return choice;
  const tool = tools.find(
    item =>
      item.name === choice.name &&
      item.namespace === choice.namespace,
  );
  if (!tool) throw new GatewayError(400, 'invalid_request', 'Unknown forced tool.');

  const wireName = wireNames.get(tool);
  if (wireName === undefined) {
    throw new GatewayError(500, 'provider_error', 'Tool mapping failed.');
  }
  return { type: 'function', function: { name: wireName } };
}

function upstreamHistory(
  history: readonly HistoryMessage[],
  wireNames: ReadonlyMap<ResponsesTool, string>,
): Obj[] {
  const identities = new Map<string, string>();
  for (const [tool, wireName] of wireNames) {
    identities.set(toolIdentity(tool.name, tool.namespace), wireName);
  }

  return history.map(message => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      return {
        role: message.role,
        content: message.content,
        ...(message.reasoning === undefined
          ? {}
          : { reasoning_content: message.reasoning }),
      };
    }

    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map(call => {
        const wireName = identities.get(toolIdentity(call.name, call.namespace));
        if (wireName === undefined) {
          throw new GatewayError(500, 'provider_error', 'Historical tool mapping failed.');
        }
        return {
          id: call.callId,
          type: 'function',
          function: { name: wireName, arguments: call.arguments },
        };
      }),
      ...(message.reasoning === undefined ? {} : { reasoning_content: message.reasoning }),
    };
  });
}

function structuredOutput(event: Obj): {
  value: unknown;
  finish: NormalizedFinishReason;
} {
  if (Array.isArray(event.choices)) {
    if (event.choices.length !== 1) {
      throw new GatewayError(502, 'invalid_upstream', 'Expected one upstream choice.');
    }
    const choice = upstreamRecord(event.choices[0]);
    const message = upstreamRecord(choice.message);
    const finish = normalizeFinishReason(field(choice.finish_reason) ?? '');
    if (finish === 'tool_calls') {
      throw new GatewayError(502, 'invalid_upstream', 'Unsupported structured finish reason.');
    }
    const content = message.content;
    if (typeof content === 'string') {
      try {
        return { value: JSON.parse(content) as unknown, finish };
      } catch {
        throw new GatewayError(502, 'invalid_upstream', 'Structured output is not valid JSON.');
      }
    }
    if (content !== null && typeof content === 'object' && !Array.isArray(content)) {
      return { value: content, finish };
    }
    throw new GatewayError(502, 'invalid_upstream', 'Structured output is missing.');
  }

  const response = event.response;
  if (response !== undefined && response !== '') {
    if (typeof response === 'string') {
      try {
        return { value: JSON.parse(response) as unknown, finish: 'stop' };
      } catch {
        throw new GatewayError(502, 'invalid_upstream', 'Structured output is not valid JSON.');
      }
    }
    if (response !== null && typeof response === 'object' && !Array.isArray(response)) {
      return { value: response, finish: 'stop' };
    }
  }

  throw new GatewayError(502, 'invalid_upstream', 'Upstream structured response is missing output.');
}

function structuredChunk(event: Obj, usage: NormalizedUsage | undefined): NormalizedChunk {
  const structured = structuredOutput(event);
  return {
    structuredValue: structured.value,
    finish: structured.finish,
    ...(usage === undefined ? {} : { usage }),
  };
}

function normalizeErrorValue(error: unknown): NormalizedError {
  if (error instanceof GatewayError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  const e = error !== null && typeof error === 'object' ? error as Obj : {};
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : 0;
  const retryable = status === 429 || (status >= 500 && status <= 599) || e.code === 4006;
  return {
    status: status === 429 ? 429 : 502,
    code: 'upstream_error',
    message: 'Workers AI request failed.',
    retryable,
  };
}

function toGatewayError(error: unknown): GatewayError {
  const normalized = normalizeErrorValue(error);
  return new GatewayError(
    normalized.status,
    normalized.code,
    normalized.message,
    normalized.retryable,
  );
}

export const glmProvider: ProviderAdapter = {
  model: GLM_MODEL,
  normalizeError: normalizeErrorValue,

  normalizeRequest(request: ResponsesRequest): UpstreamRequest {
    const toolMap = assignWireNames(request.tools);
    const wireNames = new Map<ResponsesTool, string>(
      [...toolMap.entries()].map(([wireName, tool]) => [tool, wireName] as const),
    );
    const structured = request.outputSchema !== undefined;
    const toolChoice =
      request.tools.length === 0
        ? undefined
        : upstreamToolChoice(request.toolChoice, request.tools, wireNames);

    const input = {
      messages: upstreamHistory(request.history, wireNames),
      ...(structured
        ? {
            stream: false,
            response_format: {
              type: 'json_schema',
              json_schema: request.outputSchema,
            },
          }
        : {
            stream: true,
            stream_options: { include_usage: true },
          }),
      max_completion_tokens: request.tokens,
      parallel_tool_calls: false,
      reasoning_effort: request.effort ?? 'max',
      ...(request.tools.length === 0
        ? {}
        : {
            tools: request.tools.map(tool => {
              const wireName = wireNames.get(tool);
              if (wireName === undefined) {
                throw new GatewayError(500, 'provider_error', 'Tool mapping failed.');
              }
              return {
                type: 'function',
                function: {
                  name: wireName,
                  description: tool.description,
                  parameters: tool.schema,
                },
              };
            }),
            tool_choice: toolChoice,
          }),
    };

    return {
      model: UPSTREAM_MODEL,
      input,
      stream: !structured,
      ...(structured ? { structuredSchema: request.outputSchema } : {}),
      toolMap,
      ...(request.affinity === undefined
        ? {}
        : { options: { extraHeaders: { 'x-session-affinity': request.affinity } } }),
    };
  },

  normalizeChunk(raw: unknown): NormalizedChunk {
    const event = upstreamRecord(raw);
    if (event.error !== undefined) throw toGatewayError(event.error);

    const usage = normalizeUsage(event.usage);
    if (event.choices === undefined && isUsageTrailer(event, usage)) {
      return { usage };
    }

    if (event.choices === undefined && event.response !== undefined && event.response !== '') {
      return structuredChunk(event, usage);
    }

    if (!Array.isArray(event.choices) || event.choices.length > 1) {
      throw new GatewayError(502, 'invalid_upstream', 'Expected one upstream choice.');
    }
    if (!event.choices.length) return usage === undefined ? {} : { usage };

    const choice = upstreamRecord(event.choices[0]);
    if (choice.message !== undefined && choice.delta === undefined) {
      return structuredChunk(event, usage);
    }

    if (choice.index !== 0) {
      throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream choice index.');
    }
    const delta = upstreamRecord(choice.delta);
    if (delta.refusal || delta.audio || delta.function_call) {
      throw new GatewayError(502, 'unsupported_upstream', 'Unsupported upstream output.');
    }

    const calls = delta.tool_calls;
    if (calls != null && !Array.isArray(calls)) {
      throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream tool delta.');
    }

    const finish = field(choice.finish_reason);
    const normalizedFinish = finish === undefined ? undefined : normalizeFinishReason(finish);
    const text = field(delta.content);
    const reasoning = field(delta.reasoning_content);

    return {
      ...(text === undefined ? {} : { text }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(Array.isArray(calls)
        ? { toolCalls: calls.map(normalizeToolCall) }
        : {}),
      ...(normalizedFinish === undefined ? {} : { finish: normalizedFinish }),
      ...(usage === undefined ? {} : { usage }),
    };
  },
};

export function glmCodexModelsResponse() {
  return buildCodexModelsResponse(GLM_MODEL);
}
