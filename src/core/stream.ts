import { encoder, GatewayError, type Lifetime } from '../utils/runtime';
import type { ResponsesEvent } from './types';

export function eventStream(
  events: AsyncGenerator<ResponsesEvent>,
  life: Lifetime,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await events.next();
          if (next.done) {
            controller.close();
            return;
          }

          controller.enqueue(
            encoder.encode(
              `event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`,
            ),
          );

          if (
            ['response.completed', 'response.failed', 'response.incomplete'].includes(
              next.value.type,
            )
          ) {
            // The response generator logs the terminal summary in its finally block.
            await events.return(undefined);
            controller.close();
          }
        } catch (error) {
          console.error(
            JSON.stringify({
              phase: 'event_stream_error',
              error:
                error instanceof Error
                  ? { name: error.name, message: error.message, stack: error.stack }
                  : String(error),
            }),
          );
          life.close();
          controller.error(new Error('Response stream ended.'));
        }
      },

      async cancel() {
        life.controller.abort(
          new GatewayError(499, 'cancelled', 'Client cancelled response.'),
        );
        try {
          await events.return(undefined);
        } finally {
          life.close();
        }
      },
    },
    { highWaterMark: 0 },
  );
}
