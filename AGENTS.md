# Agent Guidelines

Open Responses Worker is a self-hosted Responses API gateway for Cloudflare Workers AI.

The project implements a focused subset of the OpenAI Responses API for Codex and other Responses API clients. It is intentionally not a general OpenAI-compatible proxy.

## Project Scope

- Target the Cloudflare Workers runtime directly with TypeScript and Wrangler.
- Production inference uses the Cloudflare Workers AI binding through `env.AI.run()`.
- Keep the implementation focused on the Responses API.
- Do not add Chat Completions compatibility.
- Do not turn the project into a generic model proxy, multi-tenant gateway, billing platform, or administration service.
- Tools are executed by the client, such as Codex. The gateway only converts tool declarations, calls, and results.
- HTTP requests are stateless and require the necessary conversation history in the request.
- WebSocket continuation state is connection-local and must not be treated as durable server-side session state.
- Do not introduce Durable Objects or persistent server-side conversation storage unless required by an explicitly approved design change.

## Architecture

Keep responsibilities separated across the existing layers:

```text
src/
├─ index.ts
├─ routes/
├─ core/
├─ providers/
└─ utils/
```

### `core/`

`core/` implements provider-independent Responses API behavior.

- `core/` must not contain provider names, upstream model IDs, or provider-specific protocol branches.
- Generic Responses behavior that should work across providers belongs here.
- Consume normalized provider output rather than raw upstream events.
- Keep response state, tool-call handling, request parsing, and streaming responsibilities separated.
- Do not add checks such as `model.startsWith(...)` or provider-name switches inside `core/`.

### `providers/`

Provider-specific compatibility belongs under `providers/`.

- Keep `ProviderAdapter` small.
- Abstract only demonstrated provider differences.
- Do not build a plugin framework or dependency-injection system for hypothetical future providers.
- Use the existing `getProvider(model)` registry until a more complex mechanism is actually required.
- Provider adapters may normalize:
  - model aliases and upstream model identifiers
  - request message formats
  - reasoning fields
  - tool declarations and tool calls
  - streaming chunk shapes
  - finish reasons
  - usage information
  - provider metadata
  - provider errors
- Provider-specific fallbacks must remain in the relevant adapter rather than leaking into `core/`.

### Workers AI transport

`providers/workers-ai.ts` is the Workers AI transport layer.

- Keep `env.AI.run()` invocation here.
- Keep upstream SSE parsing here.
- Apply the selected provider adapter to normalize upstream chunks and errors.
- Do not move provider-specific model behavior into the transport layer.
- Do not use Cloudflare REST inference or store Cloudflare Account API tokens inside the Worker.

## TypeScript and Dependencies

- Keep TypeScript strict checking enabled.
- Start untrusted external input as `unknown` and validate before narrowing.
- Avoid `any`, broad type assertions, and unchecked structural assumptions.
- Prefer explicit data structures, discriminated unions, and small functions.
- Prefer native Workers/Web APIs:
  - `Request`
  - `Response`
  - `URL`
  - `Headers`
  - Web Streams
  - `TextEncoder`
  - `TextDecoder`
  - Web Crypto
- Keep third-party runtime dependencies at zero by default.
- Wrangler, TypeScript, and official development/build tooling may remain development dependencies.
- Do not add routing frameworks, model SDKs, generic gateway libraries, schema libraries, or utility collections without a concrete need.
- Do not enable `nodejs_compat` or introduce Node.js-only APIs without a documented runtime requirement.

## Responses Protocol

Preserve clear protocol semantics.

- Keep response IDs, item IDs, and tool call IDs distinct.
- Preserve tool-call/result pairing and ordering.
- Maintain consistency between streaming deltas and final output items.
- Support multiple concurrent tool calls by tracking them independently.
- Tool call indexes may be absent or provider-specific upstream; normalize them before they enter the core protocol implementation.
- Do not silently discard semantically meaningful input fields.
- Do not fabricate unsupported OpenAI behavior.
- Missing usage information must remain unknown or `null`; never fabricate zero usage.
- Distinguish:
  - `completed`
  - `failed`
  - `incomplete`
  - cancellation/disconnection
- EOF without a valid terminal condition is not automatically a successful completion.
- Do not convert an upstream or in-stream failure into a successful response.

## Tools and JSON Schema

- Validate tool names before exposing them to the provider or client.
- Preserve reversible mappings when provider limitations require transformed tool names.
- Fully accumulate streamed tool arguments before final validation and emission.
- Validate tool argument JSON syntax before output is committed.
- Validate tool arguments against the supported schema subset.
- Invalid arguments must not enter final output or subsequent conversation history.
- Do not guess or repair truncated tool arguments as if they were valid.
- Tool execution remains outside the gateway.
- The gateway must never execute shell commands, patches, filesystem operations, or model-suggested tools itself.
- Reject unsupported JSON Schema features explicitly rather than silently ignoring them.
- Do not claim full JSON Schema compatibility when only a bounded subset is implemented.

## Streaming and Resource Safety

Streaming paths must remain incremental and bounded.

- Correctly handle UTF-8 across chunks.
- Correctly handle SSE records split across packets and lines.
- Respect stream backpressure.
- Propagate cancellation and client disconnection.
- Enforce total request deadlines and upstream idle timeouts.
- Release readers, timers, and other resources on completion, failure, and cancellation.
- Every accumulation buffer must have an explicit bound.
- Avoid unbounded arrays and repeated large-string copying in streaming loops.
- Avoid per-token logging.
- Generated text may be emitted incrementally.
- Tool arguments must not be finalized until fully accumulated and validated.

## Retry Semantics

Retries must never corrupt already-visible output.

- Retry only before meaningful response content has been committed to the client.
- Protocol lifecycle events such as `created` or `in_progress` alone do not count as committed generated content.
- After a content item has been committed, do not regenerate or replace that response.
- Keep retry limits explicit and bounded.
- Share retry attempts and request deadlines across retry causes rather than resetting them indefinitely.

## WebSocket Behavior

- WebSocket support is an existing transport, not a separate protocol implementation.
- Reuse the same provider-independent request and response logic where practical.
- Keep continuation state scoped to the active connection.
- `previous_response_id` over WebSocket must not imply durable server-side storage.
- Reconnection must not silently invent missing conversation state.
- `generate: false` prewarming must not trigger model inference.
- Apply the same authentication, validation, resource limits, and provider boundaries as HTTP requests.

## Security and Privacy

- Require Bearer authentication for inference and model-list endpoints.
- Validate requested models against the configured provider/model allowlist.
- `/health` must not invoke a model or expose secrets or internal configuration.
- Keep secrets in Wrangler secrets or ignored local configuration.
- Never hard-code secrets.
- Never place secrets in URLs, query parameters, repository files, or logs.
- Do not log:
  - prompts
  - source code or source text
  - tool results
  - generated response bodies
  - tool argument bodies
  - authentication tokens
- Operational logs may contain bounded metadata such as request ID, model, status, latency, attempts, and usage when available.
- Keep input size, schema size, tool output size, generated output size, timeout, and rate limits explicit and configurable.
- Do not weaken baseline protections merely because a deployment is intended for personal use.

## Performance and Implementation Style

Priority order:

1. correctness
2. stability
3. maintainability
4. performance
5. provider count

- Prefer straightforward readable code over clever abstractions.
- Avoid code golf and obscure optimizations.
- Avoid whole-object deep copies on hot paths when a simpler bounded representation is sufficient.
- Avoid duplicate parsing and serialization.
- Do not claim performance improvements without measurement.
- Do not report p50, p95, throughput, or latency improvements unless they were actually measured.
- Keep changes focused on demonstrated requirements.

## Verification

After code changes, use the existing project scripts where applicable:

```sh
npm run typecheck
npm run build
```

- `npm run typecheck` must continue to pass with TypeScript strict mode.
- `npm run build` must continue to pass the Wrangler dry-run build.
- Static checking and successful bundling do not prove runtime compatibility.
- Changes affecting provider behavior, streaming, tool calls, or WebSocket behavior should be validated against the actual affected client/provider when practical.
- Remote inference may incur charges; do not perform paid remote calls without authorization.
- Record the actual client/model/version when documenting compatibility results.
- A successful Codex CLI check does not automatically establish compatibility with every other client.
- Do not overstate validation scope.

Automated tests are not currently part of the repository. If tests are introduced later, keep them focused on protocol behavior and avoid adding a large framework solely for trivial assertions.

## Change Discipline

- Read the code relevant to the requested change before modifying behavior.
- Keep changes scoped; avoid unrelated refactors or repository-wide formatting.
- Do not add placeholder modules for hypothetical future functionality.
- Do not add provider adapters until there is a real provider integration to support.
- Do not upgrade unrelated dependencies as part of an implementation change.
- Preserve existing public behavior unless the change intentionally modifies it.
- Update README documentation when public configuration, endpoints, supported behavior, or limitations change.
- Update `AGENTS.md` when architectural boundaries themselves change.
- Do not deploy, publish, push, rotate secrets, or perform destructive external actions as part of ordinary code modification unless explicitly authorized.

## Design Principle

Keep the core independent of upstream provider quirks.

If behavior would be required regardless of which model provider is used, it probably belongs in `core/`.

If behavior exists only because a specific provider represents requests, streaming events, tool calls, reasoning, usage, or errors differently, it belongs in that provider's adapter.
