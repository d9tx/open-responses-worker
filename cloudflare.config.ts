import { bindings, defineConfig } from "cf/config";

export default defineConfig({
	worker: {
		name: "open-responses-worker",
		compatibilityDate: "2026-09-14",
		entrypoint: "src/index.ts",
		observability: {
			enabled: false,
		},
		env: {
			INFERENCE_ENABLED: bindings.text<string>("true"),
			MAX_BODY_BYTES: bindings.text<string>("16777216"),
			MAX_OUTPUT_BYTES: bindings.text<string>("2097152"),
			MAX_TOOL_BYTES: bindings.text<string>("262144"),
			MAX_SCHEMA_BYTES: bindings.text<string>("262144"),
			MAX_TOOLS: bindings.text<string>("256"),
			MAX_OUTPUT_TOKENS: bindings.text<string>("65536"),
			REQUEST_TIMEOUT_MS: bindings.text<string>("180000"),
			IDLE_TIMEOUT_MS: bindings.text<string>("60000"),
			BODY_IDLE_TIMEOUT_MS: bindings.text<string>("15000"),
			MAX_ATTEMPTS: bindings.text<string>("3"),
			WS_MAX_CONNECTION_BYTES: bindings.text<string>("67108864"),
			WS_MAX_CONNECTION_MS: bindings.text<string>("3600000"),
			GATEWAY_TOKEN: bindings.secret(),
			AI: bindings.ai({}),
			INFERENCE_RATE_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: {
					limit: 60,
					period: 60,
				},
			}),
		},
	},
});
