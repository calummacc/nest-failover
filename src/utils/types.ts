/**
 * Version 2 public types: multi-operation providers, retry policies, and core options.
 * All comments must be in English and provide clear details for maintainers and users.
 */

// Operation shape for type-safe inputs/outputs
export type OpShape<I = unknown, O = unknown> = { in: I; out: O };

// Multi-operation provider
export interface MultiOpProvider<Ops extends Record<string, OpShape>> {
  /**
   * Human-readable provider name used for logs, metrics, and filtering.
   * This value should be unique among providers participating in the same orchestrator.
   */
  name: string;

  /**
   * Capabilities implemented by this provider. Each key is an operation name and its value
   * is a function that accepts the operation input and resolves to the operation output.
   */
  capabilities: {
    [K in keyof Ops]: (input: Ops[K]['in']) => Promise<Ops[K]['out']>;
  };

  /**
   * Optional hook executed before attempting a given operation.
   * Implementations may perform lightweight validation or tracing. Avoid long-running work here.
   */
  beforeExecuteOp?<K extends keyof Ops>(op: K, input: Ops[K]['in']): void | Promise<void>;

  /**
   * Optional hook executed after a successful operation attempt for this provider.
   * Implementations may emit metrics or tracing. Avoid long-running work here.
   */
  afterExecuteOp?<K extends keyof Ops>(op: K, input: Ops[K]['in'], output: Ops[K]['out']): void | Promise<void>;
}

// Legacy single-op provider (v1)
export interface IProvider<Input = unknown, Output = unknown> {
  /** Optional human-readable name used in logs and filtering. */
  name?: string;
  /** Execute the single capability provided by this provider. */
  execute(input: Input): Promise<Output>;
}

// Retry / backoff policy
export type RetryPolicy = {
  /** Number of retries after the first attempt. Not counting the initial attempt. */
  maxRetry?: number; // default 0
  /** Base delay in milliseconds used by the backoff strategy. */
  baseDelayMs?: number; // default 200
  /** Maximum delay cap in milliseconds for strategies that grow over time. */
  maxDelayMs?: number; // default 5000
  /** Backoff strategy to compute delay between attempts. */
  backoff?: import('./backoff').BackoffKind; // default 'fullJitter'
};

// Global policy config
export type PolicyConfig<OpNames extends string = string> = {
  /** Default policy applied when no other policy overrides are present. */
  default?: RetryPolicy;
  /** Per-operation override policies. */
  perOp?: Partial<Record<OpNames, RetryPolicy>>;
  /** Per-provider override policies by provider name. */
  perProvider?: Record<string, RetryPolicy>;
};

// Errors
export type ProviderAttemptError = {
  /** Provider name for the failed attempt. */
  provider: string;
  /** Operation name if applicable. */
  op?: string;
  /** Attempt index (0-based; 0 is the initial attempt). */
  attempt: number;
  /** The error thrown by this attempt. */
  error: unknown;
};

export class AllProvidersFailedError extends Error {
  /**
   * Create an error describing that all participating providers failed for the given operation.
   * The attempts array contains detailed failures for every attempt across providers.
   */
  constructor(
    public readonly op: string | undefined,
    public readonly attempts: ProviderAttemptError[],
  ) {
    const suffix = op ? ' for op ' + '"' + String(op) + '"' : '';
    super('All providers failed' + suffix);
    this.name = 'AllProvidersFailedError';
  }
}

// Core options (v2)
export type FallbackCoreOptions<Ops extends Record<string, OpShape> = any> = {
  /**
   * Providers to orchestrate. Support both legacy single-op and v2 multi-op providers.
   * Optional per-provider policy on each entry will be merged with global policies.
   */
  providers: Array<
    | { provider: IProvider<any, any>; policy?: RetryPolicy } // legacy single-op provider
    | { provider: MultiOpProvider<Ops>; policy?: RetryPolicy } // v2 multi-op provider
  >;

  /** Global policy configuration with defaults and overrides. */
  policy?: PolicyConfig<keyof Ops & string>;

  /** Global hooks for observability and telemetry across providers. */
  hooks?: {
    /**
     * Called when a provider attempt succeeds. Includes execution metadata.
     */
    onProviderSuccess?: (
      ctx: { provider: string; op?: string; attempt: number; durationMs: number },
      input: unknown,
      output: unknown,
    ) => void | Promise<void>;

    /**
     * Called when a provider attempt fails. Includes execution metadata.
     */
    onProviderFail?: (
      ctx: { provider: string; op?: string; attempt: number; durationMs: number; delayMs?: number },
      input: unknown,
      error: unknown,
    ) => void | Promise<void>;

    /**
     * Called once when all participating providers have failed for the given operation.
     */
    onAllFailed?: (ctx: { op?: string }, input: unknown, errors: ProviderAttemptError[]) => void | Promise<void>;
  };
};

// Internal normalized descriptor for providers
export type NormalizedProvider<Ops extends Record<string, OpShape>> = {
  /** The resolved provider name. */
  name: string;
  /** Optional per-provider policy directly attached to the provider entry. */
  policy?: RetryPolicy;
  /** Indicates whether the original provider is multi-op. */
  isMulti: boolean;
  /** The multi-op provider instance when available. */
  multi?: MultiOpProvider<Ops>;
  /** The single-op legacy provider instance when available. */
  single?: IProvider<any, any>;
};


