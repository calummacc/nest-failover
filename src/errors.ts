/**
 * Error thrown when all selected providers fail in an executeAny-like orchestration.
 * Carries the individual errors for inspection by callers.
 */
export class AllProvidersFailedError extends Error {
  constructor(public readonly errors: unknown[]) {
    super('All selected providers failed');
    this.name = 'AllProvidersFailedError';
  }
}


