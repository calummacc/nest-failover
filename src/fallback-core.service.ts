import { Injectable, Logger } from '@nestjs/common';
import {
  AllProvidersFailedError,
  FallbackCoreOptions,
  MultiOpProvider,
  NormalizedProvider,
  OpShape,
  ProviderAttemptError,
  RetryPolicy,
  IProvider,
} from './utils/types';
import { computeDelayMs, sleep } from './utils/backoff';
import { resolvePolicy as resolveEffectivePolicy } from './utils/policy';

/**
 * Generic multi‑provider orchestrator service.
 *
 * Coordinates multiple providers that implement the same capability (mail, upload, SMS, etc.)
 * and offers several execution strategies:
 * - Sequential fallback by priority (first success wins)
 * - Parallel execution returning all outcomes
 * - Parallel execution resolving on the first success (Promise.any semantics)
 * - Filtered execution to a subset of providers, either in parallel or sequentially
 *
 * Per‑provider retry behavior can be configured via options, along with lifecycle hooks
 * for success/failure events and the all‑failed condition. Logging uses NestJS Logger.
 */
@Injectable()
export class FallbackCoreService<Ops extends Record<string, OpShape> = any> {
  private readonly logger = new Logger(FallbackCoreService.name);

  /** Normalized provider list in configured order for deterministic iteration. */
  private readonly providers: NormalizedProvider<Ops>[];

  /** Cached global policy config for quick access. */
  private readonly policy = this.options.policy ?? {};

  /**
   * Create a new orchestrator with the given options.
   * Providers can be legacy single-op or v2 multi-op; they are normalized internally.
   */
  constructor(private readonly options: FallbackCoreOptions<Ops>) {
    this.providers = this.normalizeProviders(options.providers);
  }

  /**
   * Execute providers sequentially (priority order) with fallback.
   *
   * Behavior:
   * - Attempts each configured provider in order until one succeeds
   * - Applies per‑provider retries (`maxRetry`, `retryDelayMs`)
   * - Invokes hooks on success/failure attempts; throws the last error if all fail
   *
   * @param input Input payload forwarded to each provider
   * @returns The first successful provider's result
   * @throws The last encountered error when no provider succeeds
   */
  /**
   * NEW: sequential failover per operation.
   * Tries providers in order, applying retries with backoff until one succeeds.
   */
  async executeOp<K extends keyof Ops>(
    op: K,
    input: Ops[K]['in'],
    options?: { providerNames?: string[] },
  ): Promise<Ops[K]['out']> {
    const candidates = this.filterProvidersByNames(options?.providerNames).filter(p =>
      this.capabilityExists(p, String(op)),
    );

    const attempts: ProviderAttemptError[] = [];
    for (const provider of candidates) {
      const name = provider.name;
      const effectivePolicy = resolveEffectivePolicy({
        opName: String(op),
        providerName: name,
        globalPolicy: this.options.policy as any,
        providerInlinePolicy: provider.policy,
      });
      const maxRetry = effectivePolicy.maxRetry;
      const backoffKind = effectivePolicy.backoff;
      let prevDelayMs: number | undefined;

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        const startedAt = Date.now();
        try {
          await this.beforeOp(provider, op, input);
          const output = await this.callProviderOp(provider, op, input);
          const durationMs = Date.now() - startedAt;
          await this.afterSuccess(provider, String(op), attempt, durationMs, input, output);
          return output as Ops[K]['out'];
        } catch (error: any) {
          const durationMs = Date.now() - startedAt;
          attempts.push({ provider: provider.name, op: String(op), attempt, error });
          // Compute delay for next attempt
          let delayMs = computeDelayMs({
            kind: backoffKind,
            attempt: attempt + 1,
            baseDelayMs: effectivePolicy.baseDelayMs,
            maxDelayMs: effectivePolicy.maxDelayMs,
            prevDelayMs,
          });
          // Honor Retry-After if present on error
          if (error?.retryAfterMs != null) delayMs = Number(error.retryAfterMs) || delayMs;
          else if (error?.response?.headers?.['retry-after'] != null) {
            const ra = parseInt(error.response.headers['retry-after'], 10);
            if (!Number.isNaN(ra)) delayMs = ra * 1000;
          }
          await this.onFail(provider, String(op), attempt, durationMs, input, error, delayMs);
          if (attempt < maxRetry && delayMs > 0) {
            this.logger.debug(`Backoff: op=${String(op)}, provider=${provider.name}, attempt=${attempt}, delayMs=${delayMs}`);
            await sleep(delayMs);
            prevDelayMs = delayMs;
          }
        }
      }
    }
    await this.options.hooks?.onAllFailed?.({ op: String(op) }, input, attempts);
    this.logger.error(`All providers failed for op ${String(op)}`);
    throw new AllProvidersFailedError(String(op), attempts);
  }

  /**
   * Execute all selected providers in parallel and return individual outcomes.
   *
   * Behavior:
   * - For each provider, applies per‑provider retry settings
   * - Returns an array of objects `{ provider, result? , error? }`
   * - Never throws; failures are captured per entry
   *
   * @param input Input payload to pass to every provider
   * @param providerNames Optional filter (by provider `name` or constructor name)
   * @returns Array containing a result or error for each executed provider
   */
  /**
   * NEW: parallel-all per operation. Executes all capable providers and returns individual outcomes.
   * Does not throw; each entry contains the success or failure for the corresponding provider.
   */
  async executeAllOp<K extends keyof Ops>(
    op: K,
    input: Ops[K]['in'],
    options?: { providerNames?: string[] },
  ): Promise<
    Array<
      | { provider: string; ok: true; value: Ops[K]['out'] }
      | { provider: string; ok: false; error: unknown }
    >
  > {
    const candidates = this.filterProvidersByNames(options?.providerNames).filter(p =>
      this.capabilityExists(p, String(op)),
    );

    const tasks = candidates.map(async (provider) => {
      const name = provider.name;
      const effectivePolicy = resolveEffectivePolicy({
        opName: String(op),
        providerName: name,
        globalPolicy: this.options.policy as any,
        providerInlinePolicy: provider.policy,
      });
      const maxRetry = effectivePolicy.maxRetry;
      const backoffKind = effectivePolicy.backoff;
      let prevDelayMs: number | undefined;

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        const startedAt = Date.now();
        try {
          await this.beforeOp(provider, op, input);
          const output = await this.callProviderOp(provider, op, input);
          const durationMs = Date.now() - startedAt;
          await this.afterSuccess(provider, String(op), attempt, durationMs, input, output);
          return { provider: provider.name, ok: true as const, value: output as Ops[K]['out'] };
        } catch (error: any) {
          const durationMs = Date.now() - startedAt;
          lastError = error;
          let delayMs = computeDelayMs({
            kind: backoffKind,
            attempt: attempt + 1,
            baseDelayMs: effectivePolicy.baseDelayMs,
            maxDelayMs: effectivePolicy.maxDelayMs,
            prevDelayMs,
          });
          if (error?.retryAfterMs != null) delayMs = Number(error.retryAfterMs) || delayMs;
          else if (error?.response?.headers?.['retry-after'] != null) {
            const ra = parseInt(error.response.headers['retry-after'], 10);
            if (!Number.isNaN(ra)) delayMs = ra * 1000;
          }
          await this.onFail(provider, String(op), attempt, durationMs, input, error, delayMs);
          if (attempt < maxRetry && delayMs > 0) {
            this.logger.debug(`Backoff: op=${String(op)}, provider=${provider.name}, attempt=${attempt}, delayMs=${delayMs}`);
            await sleep(delayMs);
            prevDelayMs = delayMs;
          }
        }
      }
      return { provider: provider.name, ok: false as const, error: lastError };
    });

    return Promise.all(tasks);
  }

  /**
   * Execute selected providers in parallel and resolve on the first success.
   *
   * Semantics are similar to `Promise.any` with retries per provider:
   * - Resolves immediately when any provider eventually succeeds
   * - Retries failed attempts per `maxRetry` and `retryDelayMs`
   * - Rejects with an array of errors when all selected providers fail
   *
   * @param input Input payload to pass to every provider
   * @param providerNames Optional filter (by provider `name` or constructor name)
   * @returns The first successful result
   * @throws An array of errors when all selected providers fail
   */
  /**
   * NEW: parallel-any per operation. Resolves on first success, otherwise throws when all fail.
   */
  async executeAnyOp<K extends keyof Ops>(
    op: K,
    input: Ops[K]['in'],
    options?: { providerNames?: string[] },
  ): Promise<Ops[K]['out']> {
    const candidates = this.filterProvidersByNames(options?.providerNames).filter(p =>
      this.capabilityExists(p, String(op)),
    );
    const total = candidates.length;
    if (total === 0) {
      const attempts: ProviderAttemptError[] = [];
      await this.options.hooks?.onAllFailed?.({ op: String(op) }, input, attempts);
      throw new AllProvidersFailedError(String(op), attempts);
    }

    return new Promise<Ops[K]['out']>((resolve, reject) => {
      let settled = false;
      let failedCount = 0;
      const failures: ProviderAttemptError[] = [];

      for (const provider of candidates) {
        const name = provider.name;
        const effectivePolicy = resolveEffectivePolicy({
          opName: String(op),
          providerName: name,
          globalPolicy: this.options.policy as any,
          providerInlinePolicy: provider.policy,
        });
        const maxRetry = effectivePolicy.maxRetry;
        const backoffKind = effectivePolicy.backoff;
        let prevDelayMs: number | undefined;

        const tryOnce = async (attempt: number) => {
          if (settled) return;
          const startedAt = Date.now();
          try {
            await this.beforeOp(provider, op, input);
            const output = await this.callProviderOp(provider, op, input);
            const durationMs = Date.now() - startedAt;
            await this.afterSuccess(provider, String(op), attempt, durationMs, input, output);
            if (!settled) {
              settled = true;
              resolve(output as Ops[K]['out']);
            }
          } catch (error: any) {
            const durationMs = Date.now() - startedAt;
            failures.push({ provider: provider.name, op: String(op), attempt, error });
            let waitMs = computeDelayMs({
              kind: backoffKind,
              attempt: attempt + 1,
              baseDelayMs: effectivePolicy.baseDelayMs,
              maxDelayMs: effectivePolicy.maxDelayMs,
              prevDelayMs,
            });
            if (error?.retryAfterMs != null) waitMs = Number(error.retryAfterMs) || waitMs;
            else if (error?.response?.headers?.['retry-after'] != null) {
              const ra = parseInt(error.response.headers['retry-after'], 10);
              if (!Number.isNaN(ra)) waitMs = ra * 1000;
            }
            await this.onFail(provider, String(op), attempt, durationMs, input, error, waitMs);
            if (attempt < maxRetry && !settled) {
              if (waitMs > 0) {
                setTimeout(() => {
                  // Schedule next attempt without blocking the main execution flow
                  tryOnce(attempt + 1);
                }, waitMs);
                prevDelayMs = waitMs;
              } else {
                await tryOnce(attempt + 1);
              }
            } else {
              failedCount++;
              if (failedCount === total && !settled) {
                settled = true;
                // Fire onAllFailed hook asynchronously to avoid blocking rejection propagation
                const onAllFailed = this.options.hooks?.onAllFailed;
                if (onAllFailed) {
                  Promise.resolve(onAllFailed({ op: String(op) }, input, failures)).catch(() => undefined);
                }
                reject(new AllProvidersFailedError(String(op), failures));
              }
            }
          }
        };
        // Start attempts for this provider without awaiting to enable concurrency among providers
        tryOnce(0).catch(() => undefined);
      }
    });
  }

  /**
   * Execute only the specified providers, either in parallel or sequentially.
   *
   * - `mode = 'parallel'`: behaves like {@link executeAll} for the subset
   * - `mode = 'sequential'`: tries providers in given order; returns `{ provider, result }`
   *   for the first success, or throws the last error if all fail
   *
   * @param input Input payload forwarded to the selected providers
   * @param providerNames Required subset of providers to execute (by name)
   * @param mode Execution mode for the subset (default: `'parallel'`)
   */
  /**
   * LEGACY — keep for compatibility, mark deprecated. Treat as op = 'default'.
   */
  /** @deprecated Use executeOp with a real operation name. */
  async execute(input: unknown): Promise<unknown> {
    return this.executeOp('default' as keyof Ops, input as never);
  }

  /** @deprecated Use executeAnyOp with a real operation name. */
  async executeAny(input: unknown): Promise<unknown> {
    return this.executeAnyOp('default' as keyof Ops, input as never);
  }

  /** @deprecated Use executeAllOp with a real operation name. */
  async executeAll(input: unknown): Promise<unknown[]> {
    const results = await this.executeAllOp('default' as keyof Ops, input as never);
    return results
      .filter(r => (r as any).ok)
      .map(r => (r as any).value);
  }

  /** @deprecated Prefer `executeOp` + `providerNames`. */
  async executeWithFilter(
    input: unknown,
    providerNames: string[],
    mode: 'sequential' | 'parallel',
  ): Promise<unknown> {
    if (mode === 'parallel') {
      return this.executeAnyOp('default' as keyof Ops, input as never, { providerNames });
    }
    return this.executeOp('default' as keyof Ops, input as never, { providerNames });
  }

  /**
   * Resolve the list of providers according to an optional name filter.
   *
   * Uses `provider.name` if set, otherwise the class constructor name. If
   * no filter array is provided, all configured providers are returned.
   *
   * @param providerNames Optional list of provider names to include
   * @returns The filtered provider configuration array
   */
  /** Resolve filtered providers by optional names list. */
  private filterProvidersByNames(providerNames?: string[]): NormalizedProvider<Ops>[] {
    if (!providerNames?.length) return this.providers;
    const set = new Set(providerNames);
    return this.providers.filter(p => set.has(p.name));
  }

  /**
   * Execute a single provider with its configured retry and delay policy.
   * Invokes success/failure hooks accordingly. Throws the last error upon exhaustion.
   */
  /** Normalize mixed legacy and v2 providers into a consistent internal representation. */
  private normalizeProviders(list: FallbackCoreOptions<Ops>['providers']): NormalizedProvider<Ops>[] {
    return list.map(entry => {
      const anyProvider = entry.provider as unknown as { capabilities?: unknown; execute?: unknown; name?: string };
      const isMulti = !!(anyProvider && (anyProvider as any).capabilities);
      // Map possible legacy per-entry retry fields into an inline policy to preserve backward compatibility
      const legacyMaxRetry = (entry as any).maxRetry as number | undefined;
      const legacyRetryDelayMs = (entry as any).retryDelayMs as number | undefined;
      const legacyBackoff = (entry as any).backoff as RetryPolicy['backoff'] | undefined;
      const mergedPolicy: RetryPolicy | undefined = {
        ...(entry as any).policy,
        ...(legacyMaxRetry != null ? { maxRetry: legacyMaxRetry } : {}),
        ...(legacyRetryDelayMs != null ? { retryDelayMs: legacyRetryDelayMs } : {}),
        ...(legacyBackoff ? { backoff: legacyBackoff } : {}),
      };

      if (isMulti) {
        const multi = entry.provider as unknown as MultiOpProvider<Ops>;
        return {
          name: multi.name,
          policy: mergedPolicy,
          isMulti: true,
          multi,
        } satisfies NormalizedProvider<Ops>;
      } else {
        const single = entry.provider as unknown as IProvider<any, any>;
        const name = single.name ?? (single as any)?.constructor?.name ?? 'legacy';
        return {
          name,
          policy: mergedPolicy,
          isMulti: false,
          single,
        } satisfies NormalizedProvider<Ops>;
      }
    });
  }

  /** Determine whether a provider supports the given operation. Legacy supports only 'default'. */
  private capabilityExists(provider: NormalizedProvider<Ops>, opName: string): boolean {
    if (provider.isMulti) {
      return typeof (provider.multi as MultiOpProvider<Ops>).capabilities[opName as keyof Ops] === 'function';
    }
    return opName === 'default';
  }

  // Deprecated internal resolver removed in favor of centralized `policy.resolvePolicy` helper

  /** Execute the provider's operation, handling legacy single-op via 'default'. */
  private async callProviderOp<K extends keyof Ops>(
    provider: NormalizedProvider<Ops>,
    op: K,
    input: Ops[K]['in'],
  ): Promise<Ops[K]['out']> {
    if (provider.isMulti && provider.multi) {
      const fn = provider.multi.capabilities[op];
      return await fn(input);
    }
    // Legacy path: only supports 'default'
    if (String(op) !== 'default') {
      throw new Error(`Legacy provider "${provider.name}" does not support op "${String(op)}"`);
    }
    const result = await (provider.single as IProvider<any, any>).execute(input as unknown as any);
    return result as Ops[K]['out'];
  }

  /** Invoke provider-level and global success hooks with timing and context. */
  private async afterSuccess(
    provider: NormalizedProvider<Ops>,
    opName: string,
    attempt: number,
    durationMs: number,
    input: unknown,
    output: unknown,
  ): Promise<void> {
    if (provider.isMulti && provider.multi?.afterExecuteOp) {
      try { await provider.multi.afterExecuteOp(opName as any, input as any, output as any); } catch {}
    }
    await this.options.hooks?.onProviderSuccess?.({ provider: provider.name, op: opName, attempt, durationMs }, input, output);
  }

  /** Invoke provider-level and global failure hooks with timing and context. */
  private async onFail(
    provider: NormalizedProvider<Ops>,
    opName: string,
    attempt: number,
    durationMs: number,
    input: unknown,
    error: unknown,
    delayMs?: number,
  ): Promise<void> {
    await this.options.hooks?.onProviderFail?.({ provider: provider.name, op: opName, attempt, durationMs, delayMs }, input, error);
  }

  /** Invoke provider-level before hook when present. */
  private async beforeOp<K extends keyof Ops>(
    provider: NormalizedProvider<Ops>,
    op: K,
    input: Ops[K]['in'],
  ): Promise<void> {
    if (provider.isMulti && provider.multi?.beforeExecuteOp) {
      await provider.multi.beforeExecuteOp(op, input);
    }
  }
}
