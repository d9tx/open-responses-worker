import {
  bad,
  encoder,
  keys,
  object,
  string,
  type Obj,
  type Settings,
} from '../utils/runtime';
import { checkSchema } from '../utils/schema';
import type {
  HistoryMessage,
  HistoryToolCall,
  ReasoningEffort,
  ResponsesRequest,
  ResponsesTool,
  ToolChoice,
} from '../providers/types';
import { normalizeArguments } from './tool-calls';

interface ParseRequestOptions {
  allowEmptyInput?: boolean;
}

function toolName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    bad(`${label} must be a string of 1–64 letters, digits, underscores or hyphens.`);
  }
  return value;
}

function findTool(
  tools: ResponsesTool[],
  name: unknown,
  namespace: unknown,
): ResponsesTool | undefined {
  const originalName = toolName(name, 'Tool name');
  const originalNamespace =
    namespace === undefined ? undefined : toolName(namespace, 'Tool namespace');
  return tools.find(
    tool => tool.name === originalName && tool.namespace === originalNamespace,
  );
}

function textContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!Array.isArray(raw)) bad('Only text content is supported.');

  return raw.map(part => {
    const p = object(part);
    keys(p, ['type', 'text', 'annotations']);
    if (p.type !== 'input_text' && p.type !== 'output_text') {
      bad('Unsupported content part.');
    }
    if (
      p.annotations !== undefined &&
      (!Array.isArray(p.annotations) || p.annotations.length)
    ) {
      bad('Only empty annotations are supported.');
    }
    return string(p.text);
  }).join('');
}

function parseTools(raw: unknown, limits: Settings): ResponsesTool[] {
  if (raw !== undefined && !Array.isArray(raw)) bad('tools must be an array.');
  const rawTools: unknown[] = Array.isArray(raw) ? raw : [];
  const toolBytes = encoder.encode(JSON.stringify(rawTools)).length;
  if (rawTools.length > limits.tools) {
    bad(`Too many tool definitions: ${rawTools.length} > ${limits.tools}.`);
  }
  if (toolBytes > limits.schema) {
    bad(`Tool definitions exceed byte limit: ${toolBytes} > ${limits.schema}.`);
  }

  const tools: ResponsesTool[] = [];

  const addTool = (rawTool: unknown, namespace?: string): void => {
    const t = object(rawTool);
    if (t.type !== 'function' && t.type !== 'custom') {
      bad(
        `Unsupported tool type: ${
          typeof t.type === 'string' ? t.type : '(missing or invalid)'
        }. Only function and text custom tools are supported.`,
      );
    }
    keys(t, [
      'type',
      'name',
      'description',
      'parameters',
      'strict',
      'format',
      'defer_loading',
      'output_schema',
    ]);

    const name = toolName(t.name, 'Tool name');
    if (tools.some(tool => tool.name === name && tool.namespace === namespace)) {
      bad(`Duplicate tool name: ${namespace === undefined ? name : `${namespace}__${name}`}`);
    }
    if (tools.length >= limits.tools) {
      bad(`Too many tool definitions after namespace expansion: maximum ${limits.tools}.`);
    }

    const custom = t.type === 'custom';
    if (custom && (t.parameters !== undefined || t.strict !== undefined)) {
      bad('Invalid custom tool fields.');
    }
    if (!custom && t.format !== undefined) bad('Invalid function tool format.');
    if (t.strict !== undefined && typeof t.strict !== 'boolean') {
      bad('strict must be boolean.');
    }
    if (t.format !== undefined) {
      const f = object(t.format);
      keys(f, ['type', 'syntax', 'definition']);
      const formatType = string(f.type);
      if (formatType === 'text') {
        if (f.syntax !== undefined || f.definition !== undefined) {
          bad('Text custom tool format cannot contain grammar fields.');
        }
      } else if (formatType === 'grammar') {
        if (f.syntax === undefined || f.definition === undefined) {
          bad('Custom grammar requires syntax and definition.');
        }
        const syntax = string(f.syntax);
        string(f.definition);
        if (syntax !== 'lark') bad('Only Lark custom grammar is supported.');
      } else {
        bad('Unsupported custom tool format.');
      }
    }

    const schema = checkSchema(
      custom
        ? {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
            additionalProperties: false,
          }
        : t.parameters,
    );
    if (schema.type !== 'object') bad('Function parameters must use object root type.');

    tools.push({
      name,
      ...(namespace === undefined ? {} : { namespace }),
      description: t.description === undefined ? '' : string(t.description),
      custom,
      schema,
    });
  };

  for (const rawTool of rawTools) {
    const t = object(rawTool);
    if (t.type !== 'namespace') {
      addTool(t);
      continue;
    }

    keys(t, ['type', 'name', 'description', 'tools', 'defer_loading', 'output_schema']);
    const namespace = toolName(t.name, 'Tool namespace');
    if (t.description !== undefined) string(t.description);
    if (!Array.isArray(t.tools)) bad('Namespace tools must be an array.');
    for (const child of t.tools) addTool(child, namespace);
  }

  return tools;
}

function parseToolChoice(raw: unknown, tools: ResponsesTool[]): ToolChoice {
  let toolChoice: ToolChoice = 'auto';
  if (raw === undefined || raw === null) return toolChoice;

  if (typeof raw === 'string') {
    if (raw !== 'auto' && raw !== 'none' && raw !== 'required') {
      bad('Unsupported tool_choice.');
    }
    if (!tools.length && raw === 'required') bad('required needs tools.');
    return raw;
  }

  const choice = object(raw);
  keys(choice, ['type', 'name', 'namespace']);
  if (choice.type !== 'function' && choice.type !== 'custom') {
    bad('Unsupported forced tool type.');
  }
  const tool = findTool(tools, choice.name, choice.namespace);
  if (!tool || choice.type !== (tool.custom ? 'custom' : 'function')) {
    bad('Unknown forced tool.');
  }
  return {
    type: 'function',
    name: tool.name,
    ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
  };
}

function parseHistory(
  rawInput: unknown,
  tools: ResponsesTool[],
  limits: Settings,
  options: ParseRequestOptions,
): HistoryMessage[] {
  const items =
    typeof rawInput === 'string' ? [{ role: 'user', content: rawInput }] : rawInput;
  if (
    !Array.isArray(items) ||
    (!items.length && !options.allowEmptyInput) ||
    items.length > 4096
  ) {
    bad('input must contain 1–4096 items.');
  }

  const history: HistoryMessage[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  const callKinds = new Map<string, string>();
  let reasoning: string | undefined;

  for (const rawItem of items) {
    const item = object(rawItem);

    if (item.type === 'reasoning') {
      keys(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status']);
      if (pending.size) bad('Reasoning cannot interrupt unresolved client tool calls.');

      if (item.summary !== undefined && item.summary !== null) {
        if (!Array.isArray(item.summary)) bad('Invalid reasoning summary.');
        for (const rawPart of item.summary) {
          const p = object(rawPart);
          keys(p, ['type', 'text']);
          if (p.type !== 'summary_text') bad('Unsupported reasoning summary content.');
          string(p.text);
        }
      }

      if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        string(item.encrypted_content);
      }
      if (item.status !== undefined && item.status !== null) {
        const status = string(item.status);
        if (!['in_progress', 'completed', 'incomplete'].includes(status)) {
          bad('Invalid reasoning status.');
        }
      }
      if (item.content !== undefined && item.content !== null) {
        if (!Array.isArray(item.content)) bad('Invalid reasoning content.');
        reasoning = item.content.map(rawPart => {
          const p = object(rawPart);
          keys(p, ['type', 'text']);
          if (p.type !== 'reasoning_text') bad('Unsupported reasoning content.');
          return string(p.text);
        }).join('');
      }
      continue;
    }

    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      keys(item, ['type', 'id', 'status', 'call_id', 'name', 'namespace', 'arguments', 'input']);
      if (item.status !== undefined && item.status !== 'completed') {
        bad('Cannot replay incomplete tool calls.');
      }
      const callId = string(item.call_id);
      if (!callId || callId.length > 128 || seen.has(callId)) {
        bad('Invalid or duplicate call_id.');
      }
      const tool = findTool(tools, item.name, item.namespace);
      if (!tool || tool.custom !== (item.type === 'custom_tool_call')) {
        bad('Historical tool declaration missing or changed.');
      }
      if (tool.custom ? item.arguments !== undefined : item.input !== undefined) {
        bad('Unexpected tool input field.');
      }
      const args = tool.custom
        ? JSON.stringify({ input: string(item.input) })
        : string(item.arguments);
      if (encoder.encode(args).length > limits.tool) {
        bad('Historical arguments exceed limit.');
      }
      const normalized = normalizeArguments(args, tool);
      const call: HistoryToolCall = {
        callId,
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        arguments: normalized,
      };

      const previous = history.at(-1);
      if (pending.size && previous?.role === 'assistant' && previous.toolCalls) {
        previous.toolCalls.push(call);
      } else if (pending.size) {
        bad('Tool calls must be grouped before results.');
      } else if (
        previous?.role === 'assistant' &&
        !previous.toolCalls &&
        reasoning === undefined
      ) {
        previous.toolCalls = [call];
      } else {
        history.push({
          role: 'assistant',
          content: null,
          toolCalls: [call],
          ...(reasoning === undefined ? {} : { reasoning }),
        });
        reasoning = undefined;
      }

      seen.add(callId);
      pending.add(callId);
      callKinds.set(callId, tool.custom ? 'custom_tool_call_output' : 'function_call_output');
      continue;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      keys(item, ['type', 'id', 'call_id', 'output']);
      const callId = string(item.call_id);
      if (callKinds.get(callId) !== item.type || !pending.delete(callId)) {
        bad('Orphaned, mismatched or duplicate tool result.');
      }
      history.push({
        role: 'tool',
        content: textContent(item.output),
        toolCallId: callId,
      });
      continue;
    }

    keys(item, ['type', 'id', 'status', 'role', 'content']);
    if (item.type !== undefined && item.type !== 'message') bad('Unsupported input item.');
    if (item.status !== undefined && item.status !== 'completed') {
      bad('Incomplete messages cannot be replayed.');
    }
    const role = string(item.role);
    if (
      !['system', 'developer', 'user', 'assistant'].includes(role) ||
      pending.size
    ) {
      bad('Invalid role or missing tool results.');
    }
    if (reasoning !== undefined && role !== 'assistant') {
      bad('Reasoning must precede assistant content.');
    }
    history.push({
      role: role as HistoryMessage['role'],
      content: textContent(item.content),
      ...(reasoning === undefined ? {} : { reasoning }),
    });
    reasoning = undefined;
  }

  if (pending.size) bad(`History has unresolved tool calls: ${pending.size}`);

  // Responses history may end with a standalone reasoning item. It has no
  // following assistant item to attach to an upstream request.
  return history;
}

function parseOutputSchema(raw: unknown): Obj | undefined {
  if (raw === undefined) return undefined;
  const t = object(raw);
  keys(t, ['verbosity', 'format']);
  if (t.verbosity !== undefined) bad('text.verbosity is unsupported.');
  if (t.format === undefined) return undefined;

  const f = object(t.format);
  keys(f, ['type', 'name', 'schema', 'strict']);
  if (f.type !== 'text' && f.type !== 'json_schema') bad('Unsupported text output format.');
  if (f.strict !== undefined && typeof f.strict !== 'boolean') {
    bad('text.format.strict must be boolean.');
  }
  if (f.type === 'text') {
    if (f.name !== undefined || f.schema !== undefined) {
      bad('Text output format cannot contain schema fields.');
    }
    return undefined;
  }

  if (f.schema === undefined) bad('JSON Schema output requires text.format.schema.');
  if (f.name !== undefined && typeof f.name !== 'string') {
    bad('text.format.name must be a string.');
  }
  const schema = checkSchema(f.schema);
  if (schema.type !== 'object') bad('JSON Schema output must use object root type.');
  return schema;
}

export function parseRequest(
  raw: unknown,
  limits: Settings,
  options: ParseRequestOptions = {},
): ResponsesRequest {
  const r = object(raw);
  keys(r, [
    'model',
    'input',
    'instructions',
    'stream',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'max_output_tokens',
    'reasoning',
    'store',
    'include',
    'text',
    'prompt_cache_key',
    'client_metadata',
    'service_tier',
    'stream_options',
    'access_programs',
  ]);

  const model = string(r.model);
  if (r.store !== undefined && r.store !== false) bad('Only store=false is supported.');
  if (r.stream !== undefined && typeof r.stream !== 'boolean') {
    bad('stream must be boolean.');
  }
  if (r.parallel_tool_calls !== undefined && typeof r.parallel_tool_calls !== 'boolean') {
    bad('parallel_tool_calls must be boolean.');
  }

  let affinity: string | undefined;
  if (r.prompt_cache_key !== undefined && r.prompt_cache_key !== null) {
    if (
      typeof r.prompt_cache_key !== 'string' ||
      r.prompt_cache_key.length < 1 ||
      r.prompt_cache_key.length > 1024
    ) {
      bad('prompt_cache_key must be a non-empty string of at most 1024 characters.');
    }
    affinity = r.prompt_cache_key;
  }

  if (r.include !== undefined) {
    if (!Array.isArray(r.include)) bad('include must be an array.');
    for (const value of r.include) {
      if (value !== 'reasoning.encrypted_content') bad('Unsupported include value.');
    }
  }

  const outputSchema = parseOutputSchema(r.text);
  const tokens = r.max_output_tokens ?? limits.tokens;
  if (
    typeof tokens !== 'number' ||
    !Number.isSafeInteger(tokens) ||
    tokens < 1 ||
    tokens > limits.tokens
  ) {
    bad('Invalid output token budget.');
  }

  let effort: ReasoningEffort | undefined;
  if (r.reasoning !== undefined) {
    const reasoning = object(r.reasoning);
    keys(reasoning, ['effort', 'summary', 'context']);
    if (reasoning.effort !== undefined) {
      const value = string(reasoning.effort);
      if (value !== 'low' && value !== 'high' && value !== 'max') {
        bad(`Unsupported reasoning effort: ${value}`);
      }
      effort = value;
    }
  }

  const tools = parseTools(r.tools, limits);
  const toolChoice = parseToolChoice(r.tool_choice, tools);
  const history: HistoryMessage[] = [];

  if (r.instructions !== undefined) {
    history.push({ role: 'system', content: string(r.instructions) });
  }
  history.push(...parseHistory(r.input, tools, limits, options));

  return {
    model,
    history,
    tools,
    stream: r.stream === true,
    toolChoice,
    tokens,
    effort,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    ...(affinity === undefined ? {} : { affinity }),
  };
}
