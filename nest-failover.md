## Multi‑provider failover for NestJS

This guide introduces a small, generic module that orchestrates multiple providers for a single capability (for example: send mail, upload files, send SMS). You configure providers in priority order and choose among several execution strategies:

- Sequential fallback: try providers one by one until one succeeds
- Parallel all: run all providers in parallel and collect each outcome
- Parallel any: resolve on the first successful provider (similar to Promise.any)
- Filtered execution: run only a named subset of providers, in parallel or sequentially

In addition, you can configure per‑provider retries and lifecycle hooks for success, failure, and all‑failed conditions. The module is DI‑friendly and fully typed.

## Installation

```bash
npm install @calumma/nest-failover
# or
yarn add @calumma/nest-failover
# or
pnpm add @calumma/nest-failover
```

## Core concepts

- Provider: an implementation that performs one capability (for example, a specific email vendor). All providers share the same input/output types but implement different backends.
- Orchestrator service: coordinates multiple providers, applying retries and executing in sequential or parallel modes.
- Hooks: callbacks to observe success/failure events and when the entire orchestration has failed.

### Provider contract

```ts
import { IProvider } from '@calumma/nest-failover';

// Input and output types are domain‑specific and defined by you
export type SendMailInput = { to: string; subject: string; html?: string; text?: string };
export type SendMailResult = { id: string; accepted: boolean };

// A provider encapsulates the concrete backend logic for the capability
export class MailProviderA implements IProvider<SendMailInput, SendMailResult> {
  // Optional human‑readable name, used in logs and for filtering providers by name
  name = 'mailA';

  async execute(input: SendMailInput): Promise<SendMailResult> {
    // Perform network or SDK calls and return a typed result when successful
    // Throw an error on failure so the orchestrator can retry or fall back
    return { id: 'msg_123', accepted: true };
  }
}
```

## Module registration

Register providers in priority order (highest priority first). Configure retries and lifecycle hooks if needed.

```ts
import { Module } from '@nestjs/common';
import { FallbackCoreModule } from '@calumma/nest-failover';

@Module({
  imports: [
    FallbackCoreModule.forRoot<SendMailInput, SendMailResult>({
      providers: [
        // The orchestrator will attempt this provider first
        { provider: new MailProviderA(), maxRetry: 2, retryDelayMs: 200 },
        // The orchestrator will use this provider if the previous one exhausts retries
        { provider: new MailProviderB(), maxRetry: 1 },
      ],
      onProviderSuccess: (name, input, output) => {
        // Called once when a provider attempt succeeds
        // Use this to log success or emit metrics
      },
      onProviderFail: (name, input, error) => {
        // Called on every failed attempt (before any retry)
        // Use this to log errors or emit failure metrics
      },
      onAllFailed: (input, lastError) => {
        // Called when all providers have been exhausted without success
        // Use this for alerting or fallback workflows
      },
    }),
  ],
})
export class AppModule {}
```

### Async configuration

Use `forRootAsync` to resolve options from other modules (for example, config service) or environment variables.

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { FallbackCoreModule, FallbackCoreOptions } from '@calumma/nest-failover';

@Module({
  imports: [
    ConfigModule.forRoot(),
    FallbackCoreModule.forRootAsync<SendMailInput, SendMailResult>({
      inject: [ConfigService],
      // The factory can be async; return the orchestrator options object
      useFactory: async (cfg: ConfigService): Promise<FallbackCoreOptions<SendMailInput, SendMailResult>> => ({
        providers: [
          { provider: new MailProviderA(/* cfg */), maxRetry: 2, retryDelayMs: 200 },
          { provider: new MailProviderB(/* cfg */) },
        ],
      }),
    }),
  ],
})
export class AppModule {}
```

## Injecting and using the orchestrator

```ts
import { Injectable } from '@nestjs/common';
import { FallbackCoreService } from '@calumma/nest-failover';

@Injectable()
export class MailService {
  constructor(
    // The orchestrator is typed with your input and output shapes
    private readonly mailFallback: FallbackCoreService<SendMailInput, SendMailResult>,
  ) {}

  async sendMail(input: SendMailInput): Promise<SendMailResult> {
    // Sequential fallback: attempt each provider in order until one succeeds
    return this.mailFallback.execute(input);
  }
}
```

## Usage patterns

- Sequential (priority + fallback): `execute(input)`
  - Attempts providers in the configured array order
  - Applies per‑provider `maxRetry` and `retryDelayMs`
  - Returns the first successful result, or throws the last error if all fail

- Parallel (get all results): `executeAll(input, providerNames?)`
  - Runs the selected providers in parallel and returns an array of outcomes
  - Outcome shape: `{ provider: string; result?: TResult; error?: any }`
  - Never throws; inspect each outcome to see successes and failures

- Parallel (first success, like Promise.any): `executeAny(input, providerNames?)`
  - Resolves immediately with the first successful result
  - Rejects with an aggregated error when all selected providers fail

- Filtered execution: `executeWithFilter(input, providerNames, mode = 'parallel')`
  - `mode = 'parallel'`: behaves like `executeAll` for the selected subset
  - `mode = 'sequential'`: attempts providers in order and returns `{ provider, result }` for the first success; throws on total failure

Provider selection uses `provider.name` (if set) or the class constructor name. Keep names unique if you plan to filter by name.

### Sequential (fallback) — detailed

```ts
// Demonstrates sequential fallback with retries and hooks
async function sendWithFallback(fallback: FallbackCoreService<SendMailInput, SendMailResult>) {
  try {
    // Attempts providers in order (A then B), applying per‑provider retries
    const result = await fallback.execute({ to: 'user@example.com', subject: 'Welcome' });
    // The first successful provider’s result is returned
    return result;
  } catch (lastError) {
    // If all providers fail, the last encountered error is thrown
    // Handle, transform, or rethrow according to your domain needs
    throw lastError;
  }
}
```

Sequential subset with filtering:

```ts
// Runs only the specified providers sequentially and reveals which provider succeeded
const { provider, result } = await mailFallback.executeWithFilter(
  { to: 'user@example.com', subject: 'Digest' },
  ['mailB', 'mailA'], // Order matters; tries 'mailB' first, then 'mailA'
  'sequential',
);
```

### Parallel — detailed

```ts
// Runs selected providers in parallel and returns one outcome per provider
const outcomes = await mailFallback.executeAll({ to: 'u@example.com', subject: 'Report' });
// outcomes example: [{ provider: 'mailA', result }, { provider: 'mailB', error }]
```

First success among the selected providers:

```ts
// Resolves with the first successful provider’s result
const first = await mailFallback.executeAny(
  { to: 'x@example.com', subject: 'OTP' },
  ['mailB'], // Optional: limit which providers participate
);
```

## Multiple capabilities in one application

You can maintain separate orchestrators for different capabilities (for example, mail and upload). Prefer distinct tokens or wrapper services to avoid injection ambiguity.

### Custom provider tokens (recommended)

```ts
// tokens.ts
export const MAIL_FAILOVER = 'MAIL_FAILOVER';
export const UPLOAD_FAILOVER = 'UPLOAD_FAILOVER';
```

```ts
import { Module } from '@nestjs/common';
import { FallbackCoreService } from '@calumma/nest-failover';
import { MAIL_FAILOVER, UPLOAD_FAILOVER } from './tokens';

@Module({
  providers: [
    {
      provide: MAIL_FAILOVER,
      useFactory: () => new FallbackCoreService<SendMailInput, SendMailResult>({
        providers: [{ provider: new MailProviderA() }, { provider: new MailProviderB() }],
      }),
    },
    {
      provide: UPLOAD_FAILOVER,
      useFactory: () => new FallbackCoreService<UploadInput, UploadResult>({
        providers: [{ provider: new S3Upload() }, { provider: new GCSUpload() }],
      }),
    },
  ],
  exports: [MAIL_FAILOVER, UPLOAD_FAILOVER],
})
export class AppModule {}
```

### Wrapper classes (simple and explicit)

```ts
import { Injectable } from '@nestjs/common';
import { FallbackCoreService } from '@calumma/nest-failover';

@Injectable()
export class MailFailoverService extends FallbackCoreService<SendMailInput, SendMailResult> {
  constructor() {
    // Configure the orchestrator with domain‑specific providers and retry policies
    super({ providers: [{ provider: new MailProviderA() }, { provider: new MailProviderB() }] });
  }
}

@Injectable()
export class UploadFailoverService extends FallbackCoreService<UploadInput, UploadResult> {
  constructor() {
    // Configure the orchestrator for a different capability (file uploads)
    super({ providers: [{ provider: new S3Upload() }, { provider: new GCSUpload() }] });
  }
}
```

## API reference

Exports from `@calumma/nest-failover`:

- FallbackCoreModule
  - `forRoot<TInput, TResult>(options: FallbackCoreOptions<TInput, TResult>): DynamicModule`
  - `forRootAsync<TInput, TResult>(options: FallbackCoreModuleAsyncOptions<TInput, TResult>): DynamicModule`

- FallbackCoreService<TInput, TResult>
  - `execute(input: TInput): Promise<TResult>`
  - `executeAll(input: TInput, providerNames?: string[]): Promise<Array<{ provider: string; result?: TResult; error?: any }>>`
  - `executeAny(input: TInput, providerNames?: string[]): Promise<TResult>`
  - `executeWithFilter(input: TInput, providerNames: string[], mode?: 'parallel' | 'sequential')`

- FALLBACK_CORE_OPTIONS (Injection token for module options)
- FallbackCoreModuleAsyncOptions<TInput, TResult>

- AllProvidersFailedError
  - Thrown by `executeAny` when all selected providers fail; contains an array of individual errors

- IProvider<TInput, TResult>
  - `name?: string` — optional human‑readable name
  - `execute(input: TInput): Promise<TResult>` — perform the operation; throw on failure

- ProviderConfig<TInput, TResult>
  - `provider: IProvider<TInput, TResult>` — concrete provider implementation
  - `maxRetry?: number` — number of retries after the initial attempt (default 0)
  - `retryDelayMs?: number` — delay between retries in milliseconds (default 0)

- FallbackCoreOptions<TInput, TResult>
  - `providers: Array<ProviderConfig<TInput, TResult>>` — providers in priority order
  - `onProviderSuccess?: (providerName: string, input: TInput, output: TResult) => void`
  - `onProviderFail?: (providerName: string, input: TInput, error: any) => void`
  - `onAllFailed?: (input: TInput, lastError: any) => void`

## Error handling and logging

- Hooks provide observability for each attempt and the final outcome:
  - `onProviderSuccess` is called when a provider attempt succeeds
  - `onProviderFail` is called on every failed attempt
  - `onAllFailed` is called once when no provider succeeds overall
- The service uses the NestJS `Logger` (`debug`, `warn`, `error`). Ensure your app’s logger level includes `debug` if you want detailed traces during development.
- In `executeAny`, when all selected providers fail, the method rejects with `AllProvidersFailedError` that aggregates individual errors.

## Best practices

- Make provider operations idempotent when using retries to avoid partial side effects.
- Keep input/output payloads small and serializable if you plan to log or persist them.
- If underlying SDKs already implement retries, tune or disable orchestrator retries to avoid compounding delays.
- Use distinct tokens or wrapper services when orchestrating multiple capabilities in the same module scope.


