/**
 * Contract for a concrete provider that can perform a capability
 * (e.g., send mail, upload a file, send SMS) in the multi‑provider orchestration.
 *
 * Providers are orchestrated by {@link FallbackCoreService} which can execute them
 * sequentially with fallback, or in parallel. Implementations should be:
 * - Idempotent or safely retryable when `maxRetry` is used
 * - Side‑effect aware (avoid partial effects on failed attempts when possible)
 * - Concurrency safe, as multiple providers may run simultaneously in parallel modes
 *
 * Type parameters:
 * - TInput:  The input payload for the operation (shape is defined by your domain)
 * - TResult: The successful result returned upon completion
 */
export interface IProvider<TInput, TResult> {
  /**
   * Execute the provider's main logic.
   *
   * Implementations should throw on failure so the orchestrator can either retry
   * (if configured) or proceed to the next provider. Do not swallow errors.
   *
   * Expectations:
   * - Should be pure with respect to input; avoid mutating the provided payload
   * - Should be idempotent if `maxRetry` is used in configuration
   * - May perform network/IO calls; return the domain result when successful
   *
   * @param input The input data required to perform the operation
   * @returns A promise that resolves to the successful result
   * @throws Any error to indicate failure; it will be observed by the orchestrator
   */
  execute(input: TInput): Promise<TResult>;

  /**
   * Optional human‑readable name used for logging, debugging, and filtering.
   *
   * If omitted, the orchestrator will fall back to the class constructor name.
   * Choosing a unique, stable name is recommended if you plan to filter by
   * provider (case‑sensitive matching).
   */
  name?: string;
}
