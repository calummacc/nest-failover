import { Injectable, Logger } from '@nestjs/common';
import { FallbackCoreOptions, ProviderConfig } from './interfaces/fallback-core.options';
import { AllProvidersFailedError } from './errors';

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
export class FallbackCoreService<TInput, TResult> {
  private readonly logger = new Logger(FallbackCoreService.name);

  /**
   * Create a new orchestrator with the given options.
   *
   * @param options Root configuration including providers (in priority order),
   *                retry behavior, and lifecycle hooks.
   */
  constructor(private readonly options: FallbackCoreOptions<TInput, TResult>) {}

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
  async execute(input: TInput): Promise<TResult> {
    let lastError: any;

    for (const config of this.options.providers) {
      const providerName = config.provider.name || config.provider.constructor.name;
      const maxRetry = config.maxRetry ?? 0;
      const retryDelayMs = config.retryDelayMs ?? 0;

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          this.logger.debug(`[${providerName}] try #${attempt + 1}`);
          const result = await config.provider.execute(input);
          this.options.onProviderSuccess?.(providerName, input, result);
          this.logger.debug(`[${providerName}] success`);
          return result;
        } catch (err) {
          this.options.onProviderFail?.(providerName, input, err);
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[${providerName}] failed attempt #${attempt + 1}: ${message}`);
          lastError = err;
          if (attempt < maxRetry && retryDelayMs > 0) {
            await new Promise(res => setTimeout(res, retryDelayMs));
          }
        }
      }
    }
    this.options.onAllFailed?.(input, lastError);
    this.logger.error('All providers failed.');
    throw lastError;
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
  async executeAll(input: TInput, providerNames?: string[]): Promise<Array<{ provider: string, result?: TResult, error?: any }>> {
    const providers = this.filterProviders(providerNames);

    const promises = providers.map(async (config) => {
      const providerName = config.provider.name || config.provider.constructor.name;
      const maxRetry = config.maxRetry ?? 0;
      const retryDelayMs = config.retryDelayMs ?? 0;
      let lastErr: any;

      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          const result = await config.provider.execute(input);
          this.options.onProviderSuccess?.(providerName, input, result);
          return { provider: providerName, result };
        } catch (err) {
          this.options.onProviderFail?.(providerName, input, err);
          lastErr = err;
          if (attempt < maxRetry && retryDelayMs > 0) {
            await new Promise(res => setTimeout(res, retryDelayMs));
          }
        }
      }
      return { provider: providerName, error: lastErr };
    });

    return Promise.all(promises);
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
  async executeAny(input: TInput, providerNames?: string[]): Promise<TResult> {
    const providers = this.filterProviders(providerNames);

    return new Promise<TResult>((resolve, reject) => {
      let errorCount = 0;
      const total = providers.length;
      const errors: any[] = [];
      let settled = false;

      for (const config of providers) {
        const providerName = config.provider.name || config.provider.constructor.name;
        const maxRetry = config.maxRetry ?? 0;
        const retryDelayMs = config.retryDelayMs ?? 0;

        const tryProvider = async (attempt = 0) => {
          if (settled) return;
          try {
            const result = await config.provider.execute(input);
            if (!settled) {
              settled = true;
              this.options.onProviderSuccess?.(providerName, input, result);
              resolve(result);
            }
          } catch (err) {
            if (settled) return;
            this.options.onProviderFail?.(providerName, input, err);
            if (attempt < maxRetry) {
              if (retryDelayMs > 0) {
                setTimeout(() => tryProvider(attempt + 1), retryDelayMs);
              } else {
                tryProvider(attempt + 1);
              }
            } else {
              errors.push(err);
              errorCount++;
              if (errorCount === total) {
                const last = errors[errors.length - 1];
                this.options.onAllFailed?.(input, last);
                reject(new AllProvidersFailedError(errors));
              }
            }
          }
        };
        tryProvider();
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
  async executeWithFilter(
    input: TInput,
    providerNames: string[],
    mode: 'parallel' | 'sequential' = 'parallel',
  ): Promise<any> {
    const providers = this.filterProviders(providerNames);

    if (mode === 'parallel') {
      return this.executeAll(input, providerNames);
    } else {
      // Sequential mode: behave like execute but restricted to the selected providers only
      let lastError: any;
      for (const config of providers) {
        const providerName = config.provider.name || config.provider.constructor.name;
        try {
          const result = await this.executeProviderWithRetries(config, input);
          return { provider: providerName, result };
        } catch (err) {
          lastError = err;
        }
      }
      this.options.onAllFailed?.(input, lastError);
      throw lastError;
    }
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
  private filterProviders(providerNames?: string[]) {
    if (!providerNames?.length) return this.options.providers;
    return this.options.providers.filter(cfg =>
      providerNames.includes(cfg.provider.name || cfg.provider.constructor.name),
    );
  }

  /**
   * Execute a single provider with its configured retry and delay policy.
   * Invokes success/failure hooks accordingly. Throws the last error upon exhaustion.
   */
  private async executeProviderWithRetries(
    config: ProviderConfig<TInput, TResult>,
    input: TInput,
  ): Promise<TResult> {
    const providerName = config.provider.name || config.provider.constructor.name;
    const maxRetry = config.maxRetry ?? 0;
    const retryDelayMs = config.retryDelayMs ?? 0;
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        const result = await config.provider.execute(input);
        this.options.onProviderSuccess?.(providerName, input, result);
        return result;
      } catch (err) {
        this.options.onProviderFail?.(providerName, input, err);
        lastError = err;
        if (attempt < maxRetry && retryDelayMs > 0) {
          await new Promise(res => setTimeout(res, retryDelayMs));
        }
      }
    }

    throw lastError;
  }
}
