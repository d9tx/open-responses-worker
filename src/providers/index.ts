import { GatewayError } from '../utils/runtime';
import { GLM_MODELS_ETAG, glmCodexModelsResponse, glmProvider } from './glm';
import type { ProviderAdapter } from './types';

const providers: readonly ProviderAdapter[] = [glmProvider];

export function getProvider(model: string): ProviderAdapter {
  const provider = providers.find(candidate =>
    candidate.model.aliases.includes(model),
  );
  if (!provider) throw new GatewayError(400, 'invalid_request', 'Unsupported model.');
  return provider;
}

export function modelIds(): string[] {
  return providers.map(provider => provider.model.id);
}

// Codex model metadata. Only GLM is registered, so its catalog is served
// directly; combine catalogs here once a second provider exists.
export const CODEX_MODELS_ETAG = GLM_MODELS_ETAG;
export function codexModelsResponse() {
  return glmCodexModelsResponse();
}
