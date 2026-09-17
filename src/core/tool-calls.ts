import {
  encoder,
  GatewayError,
  id,
  upstreamRecord,
  type Settings,
} from '../utils/runtime';
import { matches } from '../utils/schema';
import type {
  NormalizedToolCallDelta,
  ResponsesRequest,
  ResponsesTool,
  ToolChoice,
  UpstreamRequest,
} from '../providers/types';
import type { ResponsesItem } from './types';

function validatedArguments(raw: string, tool: ResponsesTool): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new GatewayError(400, 'invalid_request', 'Tool arguments are not valid JSON.');
  }
  if (!matches(parsed, tool.schema)) {
    throw new GatewayError(400, 'invalid_request', 'Tool arguments do not match the declared schema.');
  }
  return parsed;
}

export function normalizeArguments(raw: string, tool: ResponsesTool): string {
  return JSON.stringify(validatedArguments(raw, tool));
}

interface FinalizedToolCall {
  item: ResponsesItem;
  field: 'input' | 'arguments';
  value: string;
  prefix: 'response.custom_tool_call_input' | 'response.function_call_arguments';
}

interface PendingToolCall {
  name: string;
  parts: string[];
  bytes: number;
}

function forcedName(choice: ToolChoice): string | undefined {
  return typeof choice === 'object' ? choice.name : undefined;
}

function forcedNamespace(choice: ToolChoice): string | undefined {
  return typeof choice === 'object' ? choice.namespace : undefined;
}

/**
 * Generic Responses capability: several calls can be accumulated independently.
 * Provider-specific wire shapes are normalized before deltas reach this class.
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, PendingToolCall>();

  get size(): number {
    return this.calls.size;
  }

  add(delta: NormalizedToolCallDelta, limits: Settings, totalBytes: number): number {
    if (!Number.isSafeInteger(delta.index) || delta.index < 0) {
      throw new GatewayError(502, 'invalid_upstream', 'Invalid upstream tool-call index.');
    }

    let call = this.calls.get(delta.index);
    if (!call) {
      call = { name: '', parts: [], bytes: 0 };
      this.calls.set(delta.index, call);
    }

    if (delta.name !== undefined) {
      if (delta.name.length > 64) {
        throw new GatewayError(502, 'invalid_upstream', 'Upstream tool name exceeds limit.');
      }
      call.name = delta.name;
    }

    if (delta.arguments === undefined) return 0;

    const size = encoder.encode(delta.arguments).length;
    call.bytes += size;
    if (call.bytes > limits.tool || totalBytes + size > limits.output) {
      throw new GatewayError(502, 'output_limit', 'Tool argument limit exceeded.');
    }
    call.parts.push(delta.arguments);
    return size;
  }

  finalize(request: ResponsesRequest, upstream: UpstreamRequest): FinalizedToolCall[] {
    const entries = [...this.calls.entries()].sort(([a], [b]) => a - b);
    const results: FinalizedToolCall[] = [];

    for (const [, call] of entries) {
      if (!call.name) {
        throw new GatewayError(502, 'invalid_upstream', 'Upstream tool call is missing a function name.', true);
      }

      const tool = upstream.toolMap.get(call.name);
      const forced = forcedName(request.toolChoice);
      if (
        !tool ||
        request.toolChoice === 'none' ||
        (forced !== undefined &&
          (forced !== tool.name || forcedNamespace(request.toolChoice) !== tool.namespace))
      ) {
        throw new GatewayError(502, 'tool_choice_violation', 'Upstream selected an undeclared or disallowed tool.', true);
      }

      let parsed: unknown;
      try {
        parsed = validatedArguments(call.parts.join(''), tool);
      } catch {
        throw new GatewayError(502, 'invalid_arguments', 'Generated tool arguments failed validation.', true);
      }
      const args = JSON.stringify(parsed);

      const callId = id('call');
      const item: ResponsesItem = {
        id: id(tool.custom ? 'ctc' : 'fc'),
        type: tool.custom ? 'custom_tool_call' : 'function_call',
        status: 'completed',
        call_id: callId,
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
      };

      const value = tool.custom
        ? String(upstreamRecord(parsed).input)
        : args;
      const field = tool.custom ? 'input' : 'arguments';
      item[field] = value;

      results.push({
        item,
        field,
        value,
        prefix: tool.custom
          ? 'response.custom_tool_call_input'
          : 'response.function_call_arguments',
      });
    }

    return results;
  }
}
