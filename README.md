### @calumma/nest-failover — Multi‑provider failover for NestJS

[![npm version](https://img.shields.io/npm/v/%40calumma%2Fnest-failover.svg)](https://www.npmjs.com/package/@calumma/nest-failover)
[![npm downloads](https://img.shields.io/npm/dm/%40calumma%2Fnest-failover.svg)](https://www.npmjs.com/package/@calumma/nest-failover)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/github-calummacc%2Fnest--failover-24292e?logo=github&logoColor=white)](https://github.com/calummacc/nest-failover)

A tiny, generic NestJS module to orchestrate multiple providers for a single capability (send mail, upload files, send SMS, …). Configure providers in priority order and the service will:

- **Sequential fallback**: try providers one by one until one succeeds
- **Parallel all**: run all in parallel and get each result
- **Parallel any**: resolve on the first success (like Promise.any)
- **Filter by provider**: run only the providers you specify
- **Retry** per provider with optional delay
- **Hooks** for success/failure and when all have failed
- **NestJS DI** friendly and fully typed at the call site

Also referred to as `@calumma/nest-multi-provider` conceptually.

Note: This package exports simple interfaces so you can plug in any provider (SDKs, HTTP clients, etc.).

### Installation

Use your favorite package manager:

```bash
npm install @calumma/nest-failover
# or
yarn add @calumma/nest-failover
# or
pnpm add @calumma/nest-failover
```

### Quick start (NestJS)

1) Implement your providers by conforming to `IProvider<TInput, TResult>`

```ts
import { IProvider } from '@calumma/nest-failover';

// Example: a mail provider using Service A
export class MailProviderA implements IProvider<SendMailInput, SendMailResult> {
  // Optional: human‑readable name used in filtering and logs
  name = 'mailA';

  async execute(input: SendMailInput): Promise<SendMailResult> {
    // Call SDK/HTTP here and return a typed result
    return { id: 'msg_123', accepted: true };
  }
}

// Example: a mail provider using Service B
export class MailProviderB implements IProvider<SendMailInput, SendMailResult> {
  name = 'mailB';
  async execute(input: SendMailInput): Promise<SendMailResult> {
    return { id: 'msg_456', accepted: true };
  }
}

export type SendMailInput = { to: string; subject: string; html?: string; text?: string };
export type SendMailResult = { id: string; accepted: boolean };
```

2) Register the module with providers in priority order

```ts
import { Module } from '@nestjs/common';
import { FallbackCoreModule } from '@calumma/nest-failover';
import { MailProviderA, MailProviderB } from './mail.providers';

@Module({
  imports: [
    FallbackCoreModule.forRoot<SendMailInput, SendMailResult>({
      providers: [
        { provider: new MailProviderA(), maxRetry: 2, retryDelayMs: 200 }, // highest priority
        { provider: new MailProviderB(), maxRetry: 1 }, // next priority
      ],
      onProviderSuccess: (name, input, output) => {
        // Hook: a provider succeeded
      },
      onProviderFail: (name, input, error) => {
        // Hook: a provider attempt failed
      },
      onAllFailed: (input, lastError) => {
        // Hook: all providers exhausted
      },
    }),
  ],
})
export class AppModule {}
```

3) Inject and use in a service/controller

```ts
import { Injectable } from '@nestjs/common';
import { FallbackCoreService } from '@calumma/nest-failover';

@Injectable()
export class MailService {
  constructor(
    private readonly mailFallback: FallbackCoreService<SendMailInput, SendMailResult>,
  ) {}

  async sendMail(input: SendMailInput): Promise<SendMailResult> {
    // Sequential fallback by priority
    return this.mailFallback.execute(input);
  }
}
```

### Usage patterns

- **Sequential (priority + fallback)**: `execute(input)`
  - Tries providers in the configured array order
  - Respects per‑provider `maxRetry` and `retryDelayMs`
  - Returns the first successful result, or throws the last error if all failed

- **Parallel (get all results)**: `executeAll(input, providerNames?)`
  - Runs the selected providers in parallel and returns an array with either `result` or `error` for each provider
  - Signature: `Promise<Array<{ provider: string; result?: TResult; error?: any }>>`

- **Parallel (first success, like Promise.any)**: `executeAny(input, providerNames?)`
  - Resolves with the first successful result
  - Rejects with an array of errors when all selected providers fail

- **Filtered execution**: `executeWithFilter(input, providerNames, mode = 'parallel')`
  - `mode = 'parallel'` returns the same shape as `executeAll`
  - `mode = 'sequential'` tries providers in the given order and returns `{ provider, result }` or throws on total failure

Provider selection uses `provider.name` (if set) or the class constructor name. Keep names unique if you want to filter precisely.

### Real‑world examples

#### Send mail with fallback

```ts
// Try A then B; if both fail, throw the last error
await this.mailFallback.execute({ to: 'user@example.com', subject: 'Hi there' });

// Run both providers and inspect all outcomes (success and failure)
const all = await this.mailFallback.executeAll({ to: 'u@example.com', subject: 'Report' });
// all: [{ provider: 'mailA', result }, { provider: 'mailB', error }]

// Resolve on the first success among the selected providers
const first = await this.mailFallback.executeAny(
  { to: 'x@example.com', subject: 'OTP' },
  ['mailB'], // optional filter
);

// Only run specific providers, sequentially
const filteredSequential = await this.mailFallback.executeWithFilter(
  { to: 'y@example.com', subject: 'Digest' },
  ['mailB', 'mailA'],
  'sequential',
);
// => { provider: 'mailB', result }
```

#### Upload files with multiple backends

```ts
type UploadInput = { buffer: Buffer; key: string };
type UploadResult = { url: string };

class S3Upload implements IProvider<UploadInput, UploadResult> {
  name = 's3';
  async execute(input: UploadInput): Promise<UploadResult> {
    return { url: `https://s3.example/${input.key}` };
  }
}

class GCSUpload implements IProvider<UploadInput, UploadResult> {
  name = 'gcs';
  async execute(input: UploadInput): Promise<UploadResult> {
    return { url: `https://storage.googleapis.com/bucket/${input.key}` };
  }
}

// Configure S3 first, then GCS as fallback
FallbackCoreModule.forRoot<UploadInput, UploadResult>({
  providers: [
    { provider: new S3Upload(), maxRetry: 2, retryDelayMs: 150 },
    { provider: new GCSUpload(), maxRetry: 0 },
  ],
});
```

### API reference

Exports from `@calumma/nest-failover`:

- `FallbackCoreModule`
  - `forRoot<TInput, TResult>(options: FallbackCoreOptions<TInput, TResult>): DynamicModule`

- `FallbackCoreService<TInput, TResult>`
  - `execute(input: TInput): Promise<TResult>`
  - `executeAll(input: TInput, providerNames?: string[]): Promise<Array<{ provider: string; result?: TResult; error?: any }>>`
  - `executeAny(input: TInput, providerNames?: string[]): Promise<TResult>`
  - `executeWithFilter(input: TInput, providerNames: string[], mode?: 'parallel' | 'sequential')`

- `IProvider<TInput, TResult>`
  - `name?: string`
  - `execute(input: TInput): Promise<TResult>`

- `ProviderConfig<TInput, TResult>`
  - `provider: IProvider<TInput, TResult>`
  - `maxRetry?: number` — number of retries after the initial attempt (default 0)
  - `retryDelayMs?: number` — delay between retries in milliseconds (default 0)

- `FallbackCoreOptions<TInput, TResult>`
  - `providers: Array<ProviderConfig<TInput, TResult>>`
  - `onProviderSuccess?: (providerName: string, input: TInput, output: TResult) => void`
  - `onProviderFail?: (providerName: string, input: TInput, error: any) => void`
  - `onAllFailed?: (input: TInput, lastError: any) => void`

Behavioral notes:
- `execute` throws the last encountered error when all providers are exhausted.
- `executeAny` rejects with an array of errors when all selected providers fail.
- `executeAll` never throws; it returns a mixed array of successes and errors.

### Writing a new provider

1) Implement the interface

```ts
import { IProvider } from '@calumma/nest-failover';

export class SmsTwilioProvider implements IProvider<SmsInput, SmsResult> {
  name = 'twilio';
  async execute(input: SmsInput): Promise<SmsResult> {
    // Perform the action and return a typed result
    return { sid: 'SMxxxxxxxx', accepted: true };
  }
}
```

2) Register it in `FallbackCoreModule.forRoot` with optional retry/delay

3) Optionally add more providers and rely on `execute`, `executeAll`, or `executeAny`

Tips:
- Set a unique `name` for clear filtering and logs.
- Keep inputs/results small and serializable if you plan to log or persist them.
- Use provider‑specific retries sparingly if the underlying SDK already retries.

### Error handling and logging

- Hooks allow you to observe lifecycle events:
  - `onProviderSuccess` is called when a provider resolves successfully.
  - `onProviderFail` is called for every failed attempt.
  - `onAllFailed` is called once when no provider succeeded.
- The service uses NestJS `Logger` with `debug`, `warn`, and `error`. Ensure your Nest logger level includes `debug` if you want detailed traces.

### How the fallback/priority pattern works

- The array passed to `providers` defines the priority from highest to lowest.
- `execute` walks this array, attempting each provider and applying per‑provider retries.
- `executeAny` starts all selected providers without waiting and resolves on the first success.
- `executeAll` starts all selected providers and aggregates individual outcomes.
- `executeWithFilter` lets you run a subset (by `name`), either in parallel or sequentially.

### Contributing & extending

- Issues and PRs are welcome on GitHub: `https://github.com/calummacc/nest-failover`
- Please include tests and examples where possible.
- Keep code comments in English and clear.
- Consider adding example providers (mail, sms, storage) to help others.

### License

MIT © Calumma
