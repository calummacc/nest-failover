import { PolicyConfig, RetryPolicy } from './types';

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxRetry: 0,
  baseDelayMs: 200,
  maxDelayMs: 5000,
  backoff: 'fullJitter',
};

function coalescePolicy(...parts: Array<RetryPolicy | undefined>): Required<RetryPolicy> {
  // Merge left-to-right with fallback to DEFAULT_POLICY
  const merged: RetryPolicy = {};
  for (const p of parts) {
    if (!p) continue;
    if (p.maxRetry !== undefined) merged.maxRetry = p.maxRetry;
    if (p.baseDelayMs !== undefined) merged.baseDelayMs = p.baseDelayMs;
    if (p.maxDelayMs !== undefined) merged.maxDelayMs = p.maxDelayMs;
    if (p.backoff !== undefined) merged.backoff = p.backoff;
  }
  return {
    maxRetry: merged.maxRetry ?? DEFAULT_POLICY.maxRetry,
    baseDelayMs: merged.baseDelayMs ?? DEFAULT_POLICY.baseDelayMs,
    maxDelayMs: merged.maxDelayMs ?? DEFAULT_POLICY.maxDelayMs,
    backoff: merged.backoff ?? DEFAULT_POLICY.backoff,
  };
}

export type ProviderInlinePolicyLookup = (providerName: string) => RetryPolicy | undefined;

/**
 * Resolve effective retry policy.
 * Precedence: perProvider[name] > perOp[op] > provider.inlinePolicy > default/global
 */
export function resolvePolicy(opts: {
  opName?: string | undefined;
  providerName: string;
  globalPolicy?: PolicyConfig<string> | undefined;
  providerInlinePolicy?: RetryPolicy | undefined; // from options.providers[i].policy
}): Required<RetryPolicy> {
  const { opName, providerName, globalPolicy, providerInlinePolicy } = opts;

  const perProvider = globalPolicy?.perProvider?.[providerName];
  const perOp = opName ? globalPolicy?.perOp?.[opName] : undefined;
  const globalDefault = globalPolicy?.default;

  // Precedence left-to-right (highest first)
  return coalescePolicy(perProvider, perOp, providerInlinePolicy, globalDefault);
}


