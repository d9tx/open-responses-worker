import {
  encoder,
  failure,
  GatewayError,
  id,
  type Lifetime,
  type Obj,
  type Settings,
} from '../utils/runtime';
import type {
  NormalizedChunk,
  NormalizedUsage,
  ResponsesRequest,
  UpstreamRequest,
} from '../providers/types';
import { ToolCallAccumulator } from './tool-calls';
import type { ResponsesEvent, ResponsesItem } from './types';

export type UpstreamStreamFactory = () => AsyncGenerator<NormalizedChunk>;

interface ActiveItem {
  item: ResponsesItem;
  index: number;
  parts: string[];
  kind: 'text' | 'reasoning';
}

function usageValue(raw: NormalizedUsage | undefined): Obj | null {
  if (!raw) return null;
  return {
    input_tokens: raw.inputTokens,
    input_tokens_details: {
      cached_tokens: raw.cachedInputTokens,
    },
    output_tokens: raw.outputTokens,
    total_tokens: raw.inputTokens + raw.outputTokens,
  };
}

export async function* responses(
  request: ResponsesRequest,
  upstream: UpstreamRequest,
  createUpstream: UpstreamStreamFactory,
  life: Lifetime,
  limits: Settings,
  requestId: string,
  generate = true,
): AsyncGenerator<ResponsesEvent> {
  const created = Math.floor(Date.now() / 1000);
  const start = Date.now();

  let sequence = 0;
  let committed = false;
  let attempts = 0;
  let terminal = 'cancelled';

  let output: ResponsesItem[] = [];
  let rawUsage: NormalizedUsage | undefined;
  let bytes = 0;

  const envelope = (status: string, error: Obj | null = null) => ({
    id: requestId,
    object: 'response',
    created_at: created,
    status,
    model: request.model,
    output,
    error,
    incomplete_details:
      status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    usage: usageValue(rawUsage),
    parallel_tool_calls: true,
    store: false,
  });

  const event = (type: string, values: Obj = {}): ResponsesEvent => ({
    type,
    sequence_number: sequence++,
    ...values,
  });

  yield event('response.created', { response: envelope('in_progress') });
  yield event('response.in_progress', { response: envelope('in_progress') });

  try {
    // WebSocket prewarm uses the same envelope, sequence and cleanup without inference.
    if (!generate) {
      terminal = 'completed';
      yield event('response.completed', { response: envelope(terminal) });
      return;
    }

    while (true) {
      attempts++;
      let active: ActiveItem | undefined;
      const calls = new ToolCallAccumulator();
      let finish: string | undefined;

      const closeItem = (status: string): ResponsesEvent[] => {
        if (!active) return [];
        const { item, index, kind, parts } = active;
        const text = parts.join('');
        const part =
          kind === 'text'
            ? { type: 'output_text', text, annotations: [] }
            : { type: 'reasoning_text', text };

        item.content = [part];
        if (kind === 'text') item.status = status;
        active = undefined;

        return [
          event(
            kind === 'text'
              ? 'response.output_text.done'
              : 'response.reasoning_text.done',
            {
              item_id: item.id,
              output_index: index,
              content_index: 0,
              text,
            },
          ),
          ...(kind === 'text'
            ? [
                event('response.content_part.done', {
                  item_id: item.id,
                  output_index: index,
                  content_index: 0,
                  part,
                }),
              ]
            : []),
          event('response.output_item.done', {
            output_index: index,
            item: { ...item },
          }),
        ];
      };

      try {
        for await (const delta of createUpstream()) {
          if (delta.usage) rawUsage = delta.usage;
          if (delta.finish) finish = delta.finish;

          for (const kind of ['reasoning', 'text'] as const) {
            const text = kind === 'text' ? delta.text : delta.reasoning;
            if (!text) continue;

            bytes += encoder.encode(text).length;
            if (bytes > limits.output) {
              throw new GatewayError(502, 'output_limit', 'Output buffer limit exceeded.');
            }
            if (
              calls.size > 0 ||
              (kind === 'reasoning' && output.some(item => item.type === 'message'))
            ) {
              throw new GatewayError(
                502,
                'unsupported_upstream',
                'Unsupported upstream output ordering.',
              );
            }

            if (active && active.kind !== kind) {
              for (const evt of closeItem('completed')) yield evt;
            }

            if (!active) {
              const item: ResponsesItem =
                kind === 'text'
                  ? {
                      id: id('msg'),
                      type: 'message',
                      status: 'in_progress',
                      role: 'assistant',
                      content: [],
                    }
                  : {
                      id: id('rs'),
                      type: 'reasoning',
                      summary: [],
                      content: [],
                    };
              const index = output.length;
              output.push(item);
              active = { item, index, parts: [], kind };
              committed = committed || request.stream;

              yield event('response.output_item.added', {
                output_index: index,
                item: { ...item },
              });
              if (kind === 'text') {
                yield event('response.content_part.added', {
                  item_id: item.id,
                  output_index: index,
                  content_index: 0,
                  part: { type: 'output_text', text: '', annotations: [] },
                });
              }
            }

            active.parts.push(text);
            yield event(
              kind === 'text'
                ? 'response.output_text.delta'
                : 'response.reasoning_text.delta',
              {
                item_id: active.item.id,
                output_index: active.index,
                content_index: 0,
                delta: text,
              },
            );
          }

          for (const call of delta.toolCalls ?? []) {
            bytes += calls.add(call, limits, bytes);
          }
        }

        if (!finish) {
          throw new GatewayError(502, 'truncated_stream', 'No upstream finish reason.');
        }

        if (finish !== 'length') {
          if ((calls.size > 0) !== (finish === 'tool_calls')) {
            throw new GatewayError(
              502,
              'invalid_upstream',
              'Tool call and finish reason mismatch.',
            );
          }

          if (
            calls.size === 0 &&
            (request.toolChoice === 'required' || typeof request.toolChoice === 'object')
          ) {
            throw new GatewayError(
              502,
              'tool_choice_violation',
              'Required tool call was not generated.',
              true,
            );
          }

          for (const call of calls.finalize(request, upstream)) {
            for (const evt of closeItem('completed')) yield evt;

            const index = output.length;
            output.push(call.item);
            committed = committed || request.stream;

            yield event('response.output_item.added', {
              output_index: index,
              item: {
                ...call.item,
                status: 'in_progress',
                [call.field]: '',
              },
            });
            yield event(`${call.prefix}.delta`, {
              item_id: call.item.id,
              output_index: index,
              delta: call.value,
            });
            yield event(`${call.prefix}.done`, {
              item_id: call.item.id,
              output_index: index,
              [call.field]: call.value,
            });
            yield event('response.output_item.done', {
              output_index: index,
              item: { ...call.item },
            });
          }

          if (!output.length) {
            throw new GatewayError(502, 'empty_upstream', 'Upstream produced no output.');
          }
        }

        terminal = finish === 'length' ? 'incomplete' : 'completed';
        for (const evt of closeItem(terminal)) yield evt;

        console.log(
          JSON.stringify({
            request_id: requestId,
            phase: 'terminal_emitting',
            terminal,
          }),
        );
        yield event(`response.${terminal}`, { response: envelope(terminal) });
        return;
      } catch (error) {
        let e = failure(error);

        // Retry only before streaming output has been committed to the client.
        if (
          !committed &&
          e.retryable &&
          attempts < 3 &&
          !life.signal.aborted
        ) {
          try {
            await life.pause(
              250 * 2 ** (attempts - 1) + Math.floor(Math.random() * 200),
            );
            output = [];
            rawUsage = undefined;
            bytes = 0;
            continue;
          } catch (pauseError) {
            e = failure(pauseError);
          }
        }

        if (!request.stream) {
          terminal = e.code === 'cancelled' ? 'cancelled' : 'failed';
          throw e;
        }

        if (life.signal.aborted && e.code === 'cancelled') return;

        for (const evt of closeItem('incomplete')) yield evt;
        terminal = 'failed';
        yield event('response.failed', {
          response: envelope('failed', { code: e.code, message: e.message }),
        });
        return;
      }
    }
  } finally {
    life.close();
    console.log(
      JSON.stringify({
        request_id: requestId,
        model: request.model,
        latency_ms: Date.now() - start,
        attempts,
        status: terminal,
        usage: usageValue(rawUsage),
        cached_input_tokens: rawUsage?.cachedInputTokens ?? null,
        cache_hit_pct:
          rawUsage === undefined || rawUsage.inputTokens <= 0
            ? null
            : Math.round((rawUsage.cachedInputTokens / rawUsage.inputTokens) * 10_000) / 100,
      }),
    );
  }
}
