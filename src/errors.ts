// Retain legacy class export for backward compatibility but favor the v2 error in `types.ts`.
export class AllProvidersFailedError extends Error {
  constructor(public readonly errors: unknown[]) {
    super('All selected providers failed');
    this.name = 'AllProvidersFailedError';
  }
}

