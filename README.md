# Open Responses Worker

A self-hosted [Cloudflare Workers](https://developers.cloudflare.com/workers/) gateway that implements a practical subset of the OpenAI **Responses API** and translates requests to Cloudflare Workers AI.

It is designed for Codex and other Responses API clients, with a provider-agnostic core and lightweight adapters for provider-specific behavior.

The current provider adapter targets **GLM-5.3**. The gateway is intentionally focused: it does not expose Chat Completions, proxy arbitrary models, or execute tools itself.

## Status

- Runtime stack: TypeScript, Cloudflare CLI (`cf`, beta, delegating bundling to Wrangler), Cloudflare Workers
- Runtime dependencies: **0**
- Provider: `@cf/zai-org/glm-5.3`
- Public model IDs: `glm-5.3`, `@cf/zai-org/glm-5.3`
- Supported transports: HTTP JSON, HTTP SSE, WebSocket
- Latest local checks: TypeScript strict check, protocol tests, and `cf deploy --dry-run` build (cf 1.0.0-beta.9, Wrangler 4.145.0) on 2026-10-01

## Features

### Responses API

- Bearer-authenticated `/v1/responses`
- String and structured text input
- Instructions and complete, stateless conversation history
- Assistant text and reasoning output
- Reasoning effort `low`, `high`, and `max`
- Default reasoning effort: `max`
- Function tools and text custom tools
- Tool namespaces and request-local aliases for long upstream tool names
- Tool argument JSON parsing and JSON Schema validation before output is committed
- Multiple tool calls in one response; `parallel_tool_calls: false` is echoed and enforced (more than one generated call is rejected and retried within the attempt limit). GLM requests are always sent upstream with `parallel_tool_calls: false`.
- Required and forced tool choice
- Streaming and non-streaming responses
- `completed`, `failed`, and `incomplete` terminal states
- Structured JSON text output for requests without tool calls

### Transport

- HTTP JSON for non-streaming responses
- HTTP SSE for streaming responses
- WebSocket transport for Codex
- Connection-local continuation with `previous_response_id`
- `generate: false` WebSocket prewarming without model inference
- Cancellation, total deadline, and idle-timeout handling
- Backoff and retry only before output has been committed to the client

### Architecture

```text
src/
├─ index.ts                 # Routing, authentication, endpoint dispatch
├─ routes/
│  ├─ responses.ts          # HTTP handling and shared request admission
│  └─ websocket.ts          # WebSocket transport and continuation state
├─ core/
│  ├─ request.ts            # Responses parsing and protocol-neutral history IR
│  ├─ response.ts           # Responses output state machine
│  ├─ stream.ts             # Responses SSE transport
│  ├─ tool-calls.ts         # Generic tool-call accumulation and validation
│  └─ types.ts
├─ providers/
│  ├─ index.ts              # getProvider(model)
│  ├─ types.ts              # Thin ProviderAdapter contract
│  ├─ workers-ai.ts         # Workers AI binding and upstream SSE transport
│  └─ glm.ts                # GLM model metadata and upstream compatibility
└─ utils/
   ├─ runtime.ts            # Errors, settings, body reading, lifetime
   ├─ schema.ts             # Bounded JSON Schema subset
   ├─ model-info.ts         # Codex model metadata generation
   └─ model-instructions.ts
```

`core/` knows only standardized model capabilities and normalized chunks. It does not contain provider names or provider-specific branches. GLM-specific request mapping, tool-call shapes, reasoning fields, finish reasons, usage details, and metadata live in `providers/glm.ts`.

## Quick start

Install dependencies and generate the local Workers type definitions into `.cloudflare/types/` (ignored by Git):

```sh
npm ci
npm run typegen
```

Copy the example file to `.dev.vars` in the repository root. `.dev.vars` is ignored by Git:

```sh
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:

```sh
GATEWAY_TOKEN=<at-least-32-random-bytes>
INFERENCE_ENABLED=false
```

Generate a token locally, for example:

```sh
openssl rand -hex 32
```

Do not place tokens in command-line arguments, repository files, URLs, or logs.

Run the development server. It listens on `localhost` by default; the `AI` binding always runs remotely, so `cf dev` requires an authenticated Cloudflare session (`npx cf auth login`):

```sh
npm run dev -- --port 8787
```

Workers AI has no local model simulator. When inference is enabled during local development, `env.AI.run()` invokes the remote Workers AI model and incurs normal Workers AI usage.

The example starts with `INFERENCE_ENABLED=false`, so inference requests return `inference_disabled`. Before making an actual inference smoke test, change it to `true` and restart the development server.

## Build and verification

```sh
npm run typecheck
npm run build
npm test
```

`npm run typecheck` regenerates the Workers types with `cf workers types` before running `tsc`.

`npm run build` runs `cf deploy --dry-run`, which builds into `.cloudflare/output/` and validates the deployment without uploading it.

`npm test` runs a small protocol-level suite in `test/` with Node's built-in test runner and TypeScript support (Node.js 22.7 or later, no additional dependencies). It covers SSE framing, UTF-8 across packets, request parsing, tool-name mapping, tool-call handling, and usage reporting against a fake `AI` binding. It runs on Node.js, not workerd, and does not call Workers AI. There is no test CI at this stage.

The available checks are:

- TypeScript strict compilation
- `cf` bundling and dry-run deployment validation
- The Node.js protocol test suite
- Manually authorized local or remote requests

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | No | Liveness response; does not call the model or expose configuration |
| `GET` | `/v1/models` | Bearer | OpenAI model list, or Codex metadata when `client_version` is present |
| `POST` | `/v1/responses` | Bearer | Responses API request; JSON or SSE depending on `stream` |
| `GET` | `/v1/responses` | Bearer | WebSocket upgrade when `Upgrade: websocket` is present |

The Worker does not provide `/v1/chat/completions`.

### Example request

```sh
curl -sS http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "glm-5.3",
    "input": "Summarize the current repository structure.",
    "store": false
  }'
```

## Codex configuration

Example `config.toml`:

```toml
model = "glm-5.3"
model_provider = "cloudflare_gateway"
model_reasoning_effort = "max"
web_search = "disabled"

[model_providers.cloudflare_gateway]
name = "Cloudflare Responses Gateway"
base_url = "http://127.0.0.1:8787/v1"
env_key = "GATEWAY_TOKEN"
wire_api = "responses"
supports_websockets = true
```

Set `GATEWAY_TOKEN` in the environment used to launch Codex.

Codex 0.154.0 may display a model-metadata warning when command-backed auth is not configured. To enable metadata fetching, use:

```toml
[model_providers.cloudflare_gateway.auth]
command = "/bin/sh"
args = ["-c", "printf %s \"$GATEWAY_TOKEN\""]
timeout_ms = 5000
refresh_interval_ms = 300000
```

`GATEWAY_TOKEN` is declared as a required secret in `cloudflare.config.ts`; its value is never stored there. For production, configure the Worker secret with Wrangler, which prompts for the value instead of taking it as a command-line argument:

```sh
npx wrangler secret put GATEWAY_TOKEN
```

Deploy with the Cloudflare CLI after authenticating:

```sh
npx cf auth login
npx cf deploy
```

Do not deploy or enable remote inference unless you have explicitly authorized the account, model access, and potential cost.

## Supported JSON Schema subset

Tool arguments and structured text output support a deliberately bounded JSON Schema subset:

- `type`, including type arrays
- `properties`
- `required`
- Boolean or schema-form `additionalProperties`
- `items`
- `minItems` and `maxItems`
- `anyOf`
- Scalar `enum`
- `description`
- `title`

Unknown validation keywords are rejected rather than silently ignored. Unsupported keywords include `$ref`, `$defs`, `oneOf`, `allOf`, `pattern`, `format`, and numeric range constraints. This is not full JSON Schema compatibility.

Tool parameters and structured output roots must use object type.

## Explicitly unsupported

- Chat Completions endpoint
- Generic model proxying
- Image, audio, or file input/output
- Built-in OpenAI tools, including `web_search`
- Encrypted reasoning data. `include: ["reasoning.encrypted_content"]` is accepted for Codex compatibility, but no encrypted content is ever emitted. Input reasoning items are validated; their `summary` and `encrypted_content` are not forwarded upstream, and only `content` reasoning text is replayed.
- Assistant phase
- `text.verbosity`
- `reasoning.effort: "medium"`
- Persistent server-side sessions
- HTTP `previous_response_id`
- Remote conversation compaction
- Grammar-based custom tools
- Durable Objects
- Native Responses passthrough
- Cloudflare REST inference or Account API tokens in the Worker

## Limits and resource protection

Values are configured in `cloudflare.config.ts`.

| Setting | Default |
| --- | --- |
| `MAX_BODY_BYTES` | 16 MiB |
| `MAX_SCHEMA_BYTES` | 256 KiB for all tool definitions |
| `MAX_TOOLS` | 256 after namespace expansion |
| `MAX_TOOL_BYTES` | 256 KiB per tool call |
| `MAX_OUTPUT_BYTES` | 2 MiB cumulative generated content |
| `MAX_OUTPUT_TOKENS` | 65,536 |
| `REQUEST_TIMEOUT_MS` | 180,000 |
| `IDLE_TIMEOUT_MS` | 60,000 for upstream stream reads |
| `BODY_IDLE_TIMEOUT_MS` | 15,000 for HTTP request body reads |
| `MAX_ATTEMPTS` | 3 upstream attempts per response, sharing one deadline |
| `WS_MAX_CONNECTION_BYTES` | 64 MiB sent per WebSocket connection |
| `WS_MAX_CONNECTION_MS` | 3,600,000 WebSocket connection lifetime |
| Rate limiter | 60 requests / 60 seconds |

A WebSocket connection is also closed after 16 consecutive request errors; the count resets whenever a response reaches a terminal event.

The rate limiter is Cloudflare-location-local and eventually consistent. It is not a global concurrency lock or a hard cost cap. Wire output is additionally bounded; JSON/SSE framing and repeated final output can make transmitted bytes larger than generated-content bytes.

## Security and privacy

- Inference and model-list endpoints require Bearer authentication.
- The gateway token must be at least 32 bytes.
- Model IDs are validated against a provider allowlist.
- Health does not call a model or expose configuration.
- Secrets are never placed in URLs or logs.
- Prompts, source text, tool results, generated text, and tool arguments are not logged.
- Terminal logs contain only request ID, model, latency, attempts, status, and usage when available.
- Missing usage is represented as `null`; it is not fabricated as zero. When the provider reports usage but not cached input tokens, `input_tokens_details` is `null`.
- Tool execution remains entirely in Codex. The gateway only converts declarations, calls, and results.

## Verification record

- **Used successfully in normal development workflows with Codex CLI 0.154.0.** The 2026-09-15 smoke coverage included text, file reading, shell/function, apply_patch, Parallel MCP, Exa MCP, multiple tool calls in one response, WebSocket continuation, reconnection, and automatic approval review against the pre-refactor implementation.
- **2026-09-16–2026-09-17:** The provider-adapter implementation has been used successfully in normal development workflows with Codex CLI 0.154.0, GLM-5.3, and remote Workers AI inference. TypeScript strict checking and Wrangler dry-run bundling also passed.
- These workflows do not cover every Responses API edge case. Desktop and long-session behavior remain unverified.

## Contributing

Issues and pull requests are welcome. Provider-specific behavior should remain isolated in `providers/`; the `core/` implementation is intended to remain provider-agnostic.

See [`AGENTS.md`](AGENTS.md) for repository architecture and development guidelines.

## License

Licensed under the [MIT License](LICENSE).
