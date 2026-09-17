import { GatewayError } from '../utils/runtime';
import { glmProvider } from './glm';
import type { ProviderAdapter } from './types';

const providers: readonly ProviderAdapter[] = [glmProvider];

export function getProvider(model: string): ProviderAdapter {
  const provider = providers.find(candidate =>
    candidate.model.aliases.includes(model),
  );
  if (!provider) throw new GatewayError(400, 'invalid_request', 'Unsupported model.');
  return provider;
}
