import { IProvider } from './provider.interface';

/**
 * Configuration for a single provider in a multi‑provider chain.
 *
 * A provider is any implementation of {@link IProvider} that can perform the same
 * capability (send mail, upload file, send SMS, …). Providers are placed in the
 * `providers` array of {@link FallbackCoreOptions} to define priority and behavior.
 */
export interface ProviderConfig<TInput, TResult> {
  /**
   * The concrete provider implementation to execute.
   *
   * The provider name used in logs and filtering is taken from `provider.name` if present,
   * otherwise from the class constructor name.
   */
  provider: IProvider<TInput, TResult>;

  /**
   * Number of retry attempts after the initial attempt for this provider.
   *
   * Total attempts = 1 (initial) + `maxRetry`.
   * @defaultValue 0
   */
  maxRetry?: number;

  /**
   * Delay in milliseconds between attempts when retrying this provider.
   *
   * Applied between each failed attempt and the next retry. Ignored if `maxRetry` is 0.
   * @defaultValue 0
   */
  retryDelayMs?: number;

  /**
   * Optional execution hint declaring the preferred mode for this provider.
   *
   * Note: The core service currently does not consume this field directly. It is provided
   * for forward compatibility and for custom orchestration wrappers. The built‑in
   * orchestration mode is chosen by the caller via service methods
   * (`execute`, `executeAll`, `executeAny`, `executeWithFilter`).
   */
  mode?: 'sequential' | 'parallel';
}

/**
 * Root configuration for the {@link FallbackCoreModule} and {@link FallbackCoreService}.
 *
 * Use this to declare which providers are available and how the orchestrator should
 * handle lifecycle events such as success, failure, and total failure.
 */
export interface FallbackCoreOptions<TInput, TResult> {
  /**
   * Providers to be orchestrated, listed in priority order (highest priority first).
   */
  providers: Array<ProviderConfig<TInput, TResult>>;

  /**
   * Hook invoked when a provider successfully resolves an attempt.
   *
   * This is called in all orchestration modes when a provider completes successfully.
   * It is safe to use this for logging or metrics. Avoid long‑running work here.
   *
   * @param providerName The resolved name of the provider (from `provider.name` or class name)
   * @param input The input that was passed to the provider
   * @param output The successful result returned by the provider
   */
  onProviderSuccess?: (providerName: string, input: TInput, output: TResult) => void;

  /**
   * Hook invoked whenever a provider attempt fails (including before any retries).
   *
   * This is called per attempt, not just per provider. Use this to observe errors
   * or emit metrics. Avoid throwing from this hook.
   *
   * @param providerName The resolved name of the provider (from `provider.name` or class name)
   * @param input The input that was passed to the provider
   * @param error The error thrown by the provider attempt
   */
  onProviderFail?: (providerName: string, input: TInput, error: any) => void;

  /**
   * Hook invoked once when no provider succeeds overall.
   *
   * This fires after all configured providers (and their retries) have been exhausted
   * in sequential mode, or when every selected provider has failed in `executeAny`.
   *
   * @param input The input that was attempted across providers
   * @param lastError The last error observed (sequential) or a representative error
   */
  onAllFailed?: (input: TInput, lastError: any) => void;
}
