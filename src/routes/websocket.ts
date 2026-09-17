import {
  bad,
  encoder,
  errorBody,
  failure,
  GatewayError,
  id,
  keys,
  Lifetime,
  object,
  type Obj,
  type Settings,
} from '../utils/runtime';
import { responses } from '../core/response';
import { prepareResponse, type ResponsesEnv } from './responses';

interface Previous {
  id: string;
  input: unknown[];
}

// Codex 0.154.0 sends flat response.create frames, including generate=false
// prewarm and previous_response_id + incremental input. Only the most recent
// completed response is retained in this socket's closure, never in global state.
export function upgradeResponses(
  env: ResponsesEnv,
  limits: Settings,
  headers: HeadersInit,
): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  const connection = new AbortController();

  // Stable fallback affinity for the lifetime of this WebSocket.
  // Codex prompt_cache_key takes precedence when provided.
  const connectionAffinity = id('session');

  let active: { id: string; life: Lifetime } | undefined;
  let previous: Previous | undefined;
  let closed = false;
  let errors = 0;
  // Workers WebSocket has no drain/bufferedAmount API. Bound total enqueued
  // wire bytes per connection as well as per response; clients may reconnect.
  let connectionBytes = 0;
  const connectionLimit = 64 * 1024 * 1024;

  const cleanup = (reason = 'Connection closed.') => {
    if (closed) return false;
    closed = true;
    clearTimeout(timer);
    previous = undefined;
    connection.abort(new GatewayError(499, 'cancelled', reason));
    active?.life.close();
    server.removeEventListener('message', onMessage);
    server.removeEventListener('close', onClose);
    server.removeEventListener('error', onError);
    return true;
  };

  const shutdown = (code = 1000, reason = 'Connection closed.') => {
    const shouldClose =
      server.readyState === WebSocket.OPEN ||
      server.readyState === WebSocket.CONNECTING;
    if (!cleanup(reason)) return;
    if (shouldClose) {
      try {
        server.close(code, reason);
      } catch {
        // Already disconnected.
      }
    }
  };

  const send = (data: string, size = encoder.encode(data).length) => {
    if (closed || server.readyState !== WebSocket.OPEN) {
      shutdown();
      throw new GatewayError(499, 'cancelled', 'Connection closed.');
    }
    connectionBytes += size;
    if (connectionBytes > connectionLimit) {
      shutdown(1000, 'Connection wire limit reached. Reconnect.');
      throw new GatewayError(499, 'cancelled', 'Connection wire limit reached.');
    }
    try {
      server.send(data);
    } catch (error) {
      shutdown(1011, 'WebSocket send failed.');
      throw error;
    }
  };

  const sendError = (error: unknown) => {
    if (closed) return;
    const e = failure(error);
    try {
      send(JSON.stringify({ type: 'error', status: e.status, ...errorBody(e) }));
    } catch {
      shutdown(1011, 'WebSocket send failed.');
    }
    if (++errors >= 16) shutdown(1008, 'Too many request errors.');
  };

  const timer = setTimeout(() => {
    sendError(
      new GatewayError(
        400,
        'websocket_connection_limit_reached',
        'Reconnect after 60 minutes.',
      ),
    );
    shutdown(1000, 'Connection time limit reached.');
  }, 60 * 60 * 1000);

  async function run(body: Obj, generate: boolean, turn: { id: string; life: Lifetime }) {
    let events: ReturnType<typeof responses> | undefined;
    let terminal = false;
    try {
      const prepared = await prepareResponse(env, body, limits, turn.life, generate);
      // A newly admitted turn replaces the connection's previous response.
      previous = undefined;
      events = responses(
        prepared.parsed,
        prepared.upstream,
        prepared.createUpstream,
        turn.life,
        limits,
        turn.id,
        generate,
      );

      let wireBytes = 0;
      let count = 0;
      for await (const event of events) {
        if (
          closed ||
          (turn.life.signal.reason instanceof GatewayError &&
            turn.life.signal.reason.code === 'cancelled')
        ) {
          break;
        }

        const data = JSON.stringify(event);
        const size = encoder.encode(data).length;
        wireBytes += size;
        if (wireBytes > limits.output * 8) {
          throw new GatewayError(
            502,
            'output_limit',
            'WebSocket response wire limit exceeded.',
          );
        }

        terminal = [
          'response.completed',
          'response.failed',
          'response.incomplete',
        ].includes(event.type);
        if (event.type === 'response.completed') {
          const result = object(event.response);
          const input =
            typeof body.input === 'string'
              ? [{ role: 'user', content: body.input }]
              : body.input ?? [];
          if (Array.isArray(input) && Array.isArray(result.output)) {
            const history = [...input, ...result.output];
            if (
              history.length <= 4096 &&
              encoder.encode(JSON.stringify(history)).length <= limits.body
            ) {
              previous = { id: turn.id, input: history };
            }
          }
        }

        if (terminal) {
          // Finish generator cleanup before making completion visible to a
          // client that can immediately send its next response.create.
          await events.return(undefined);
          turn.life.close();
          active = undefined;
          send(data, size);
          return;
        }

        send(data, size);
        // Let disconnect/cancel events run even for an already-buffered AI stream.
        if (++count % 32 === 0) await turn.life.pause(0);
      }

      if (!terminal && !closed) {
        throw turn.life.signal.reason ??
          new GatewayError(502, 'missing_response', 'Response ended without a terminal event.');
      }
    } catch (error) {
      previous = undefined;
      // Stop any outstanding upstream reader/late AI.run result before return().
      turn.life.controller.abort(failure(error));
      sendError(error);
    } finally {
      try {
        await events?.return(undefined);
      } finally {
        turn.life.close();
        if (active === turn) active = undefined;
      }
    }
  }

  function onMessage(message: MessageEvent) {
    if (closed) return;
    try {
      if (typeof message.data !== 'string') {
        sendError(new GatewayError(400, 'invalid_request', 'Use JSON text frames.'));
        shutdown(1003, 'Binary frames are unsupported.');
        return;
      }
      if (
        message.data.length > limits.body ||
        encoder.encode(message.data).length > limits.body
      ) {
        sendError(new GatewayError(413, 'body_too_large', 'Request exceeds body limit.'));
        shutdown(1009, 'Message too large.');
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(message.data) as unknown;
      } catch {
        bad('Invalid JSON frame.');
      }

      const frame = object(raw);
      if (frame.type === 'response.cancel') {
        // Optional explicit cancellation. Codex itself cancels by dropping the socket.
        keys(frame, ['type', 'response_id']);
        if (!active || (frame.response_id !== undefined && frame.response_id !== active.id)) {
          bad('No matching active response.');
        }
        active.life.controller.abort(
          new GatewayError(499, 'cancelled', 'Client cancelled response.'),
        );
        return;
      }

      if (frame.type !== 'response.create') bad('Expected response.create.');
      if (active) {
        throw new GatewayError(
          409,
          'response_in_progress',
          'Only one response may be active on this connection.',
        );
      }

      const { type: _type, previous_response_id: parent, generate = true, ...body } = frame;

      // Keep all inference turns on this WebSocket sticky to the same
      // Workers AI session when Codex does not provide its own cache key.
      if (body.prompt_cache_key === undefined || body.prompt_cache_key === null) {
        body.prompt_cache_key = connectionAffinity;
      }

      if (typeof generate !== 'boolean') bad('generate must be boolean.');
      if (body.stream !== undefined && body.stream !== true) {
        bad('WebSocket responses require stream=true or omitted.');
      }
      body.stream = true;

      if (parent !== undefined && parent !== null) {
        if (typeof parent !== 'string') bad('previous_response_id must be a string or null.');
        if (!previous || previous.id !== parent) {
          throw new GatewayError(
            400,
            'previous_response_not_found',
            'Previous response is unavailable. Retry with previous_response_id=null and full input.',
          );
        }
        const input =
          typeof body.input === 'string'
            ? [{ role: 'user', content: body.input }]
            : body.input ?? [];
        if (!Array.isArray(input)) bad('input must be an array or string.');
        body.input = [...previous.input, ...input];
      }

      if (encoder.encode(JSON.stringify(body)).length > limits.body) {
        throw new GatewayError(413, 'body_too_large', 'Expanded request exceeds body limit.');
      }

      const turn = {
        id: id('resp'),
        life: new Lifetime(connection.signal, limits.timeout),
      };
      active = turn;
      void run(body, generate, turn).catch(() => shutdown(1011, 'Response cleanup failed.'));
    } catch (error) {
      sendError(error);
    }
  }

  const onClose = () => cleanup('Connection closed.');
  const onError = () => cleanup('WebSocket error.');

  server.addEventListener('message', onMessage);
  server.addEventListener('close', onClose);
  server.addEventListener('error', onError);

  return new Response(null, { status: 101, webSocket: pair[0], headers });
}
