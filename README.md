### @calumma/nest-failover — Multi‑provider failover for NestJS 

[![npm version](https://img.shields.io/npm/v/%40calumma%2Fnest-failover.svg)](https://www.npmjs.com/package/@calumma/nest-failover)
[![npm downloads](https://img.shields.io/npm/dm/%40calumma%2Fnest-failover.svg)](https://www.npmjs.com/package/@calumma/nest-failover)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/github-calummacc%2Fnest--failover-24292e?logo=github&logoColor=white)](https://github.com/calummacc/nest-failover)


A tiny, type-safe **failover & multi-provider orchestration** module for **NestJS**.  
With v2, you can define **multi-operation providers** (e.g., `upload`, `download`, `presign`) and call them via:

- `executeOp` — **sequential** failover by priority
- `executeAnyOp` — **parallel-any**; returns the first success
- `executeAllOp` — **parallel-all**; collects all outcomes

Includes **retry with backoff** (classic algorithms + jitter), **per-op/per-provider policy**, **provider filtering**, and **observable hooks** for metrics.

> v1 single-operation API remains available but is **deprecated**. See **[Migration from v1](#migration-from-v1)**.

---

## Table of Contents

- [Why this module?](#why-this-module)
- [Install](#install)
- [Quick Start (MultiOp)](#quick-start-multiop)
- [Core Concepts](#core-concepts)
  - [Operation Shapes](#operation-shapes)
  - [MultiOpProvider Interface](#multiopprovider-interface)
  - [FallbackCoreModule Options](#fallbackcoremodule-options)
  - [Policy Resolution Precedence](#policy-resolution-precedence)
- [API Reference](#api-reference)
  - [`executeOp`](#executeop)
  - [`executeAnyOp`](#executeanyop)
  - [`executeAllOp`](#executeallop)
  - [Legacy APIs (Deprecated)](#legacy-apis-deprecated)
- [Retry & Backoff](#retry--backoff)
  - [Algorithms](#algorithms)
  - [Respecting Retry-After](#respecting-retry-after)
  - [Choosing a Strategy](#choosing-a-strategy)
- [Hooks & Telemetry](#hooks--telemetry)
- [Examples](#examples)
  - [StorageOps: upload, download, presign](#storageops-upload-download-presign)
  - [Sequential with Priority & Retry](#sequential-with-priority--retry)
  - [Parallel Any (Fastest Success)](#parallel-any-fastest-success)
  - [Parallel All (Health Fanout)](#parallel-all-health-fanout)
  - [Filtering Providers](#filtering-providers)
- [Migration from v1](#migration-from-v1)
- [Error Model](#error-model)
- [Performance Tips](#performance-tips)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [TypeScript Notes](#typescript-notes)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

---

## Why this module?

When you must call the **same capability** across multiple backends/providers (e.g., S3, R2, GCS), you often want:

- **Failover**: try providers in order until one succeeds
- **Parallel-any**: return the **first** provider that completes successfully
- **Parallel-all**: **fan out** to all providers and inspect outcomes
- **Typed input/output** per operation (not just `any`)
- **Retry with backoff** and **jitter** to avoid thundering herds
- **Per-op/per-provider policy** tuning (different SLA/behavior)
- **Hooks** for logging/metrics

This module gives you these primitives with a tiny surface and solid type-safety.

---

## Install

```bash
npm install @calumma/nest-failover
# or
yarn add @calumma/nest-failover
# or
pnpm add @calumma/nest-failover
```

Peer dep: `@nestjs/common` v9+. Works with ESM or CJS TypeScript targets.

### Named Exports

```ts
import {
  FallbackCoreModule,
  FallbackCoreService,
  OpShape,
  MultiOpProvider,
  AllProvidersFailedError,
  wrapLegacyAsMultiOp,
  // types
  RetryPolicy,
  PolicyConfig,
} from '@calumma/nest-failover';
```

---

## Quick Start (MultiOp)

Define your **operations** and a **provider**:

```ts
// types.ts
import { OpShape, MultiOpProvider } from '@calumma/nest-failover';

export type StorageOps = {
  upload:   OpShape<{ key: string; data: Buffer }, { key: string; url?: string }>;
  download: OpShape<{ key: string }, { stream: NodeJS.ReadableStream }>;
  presign:  OpShape<{ key: string; expiresIn?: number }, { url: string }>;
};

// s3.provider.ts
export class S3Provider implements MultiOpProvider<StorageOps> {
  name = 's3';
  capabilities = {
    upload:   async (i) => ({ key: i.key, url: await this.putObject(i) }),
    download: async (i) => ({ stream: await this.getStream(i.key) }),
    presign:  async (i) => ({ url: await this.signedUrl(i.key, i.expiresIn) }),
  };
  // optional per-provider hooks
  async beforeExecuteOp(op, input) { /* custom logging */ }
  async afterExecuteOp(op, input, output) { /* metrics */ }

  // ... private methods to talk to S3 SDK ...
}
```

### forRootAsync example

```ts
// app.module.ts
@Module({
  imports: [
    FallbackCoreModule.forRootAsync<StorageOps>({
      useFactory: async () => {
        // e.g. load secrets/SDK clients here
        return {
          providers: [
            { provider: new S3Provider(),  policy: { maxRetry: 2, baseDelayMs: 200 } },
            { provider: new R2Provider(),  policy: { maxRetry: 1 } },
            { provider: new GCSProvider(), policy: { maxRetry: 1 } },
          ],
          policy: {
            default: { maxRetry: 1, baseDelayMs: 150, maxDelayMs: 5000, backoff: 'fullJitter' },
            perOp: { upload: { maxRetry: 3 } },
            perProvider: { r2: { baseDelayMs: 250 } },
          },
        };
      },
      inject: [], // add ConfigService/etc. if needed
    }),
  ],
})
export class AppModule {}
```

Wire it into your module:

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { FallbackCoreModule, OpShape } from '@calumma/nest-failover';
import { S3Provider } from './s3.provider';
import { R2Provider } from './r2.provider';
import { GCSProvider } from './gcs.provider';
import { StorageOps } from './types';

@Module({
  imports: [
    FallbackCoreModule.forRoot<StorageOps>({
      providers: [
        { provider: new S3Provider(),  policy: { maxRetry: 2, baseDelayMs: 200 } },
        { provider: new R2Provider(),  policy: { maxRetry: 1 } },
        { provider: new GCSProvider(), policy: { maxRetry: 1 } },
      ],
      policy: {
        default: { maxRetry: 1, baseDelayMs: 150, maxDelayMs: 5000, backoff: 'fullJitter' },
        perOp: { upload: { maxRetry: 3 } },                 // heavier retry for upload
        perProvider: { r2: { baseDelayMs: 250 } },          // tune per provider
      },
      hooks: {
        onProviderSuccess: (ctx) => {/* log/metrics */},
        onProviderFail:    (ctx) => {/* warn/metrics */},
        onAllFailed:       (ctx) => {/* alert */},
      },
    }),
  ],
})
export class AppModule {}
```

Use it in a service:

```ts
import { Injectable } from '@nestjs/common';
import { FallbackCoreService } from '@calumma/nest-failover';
import { StorageOps } from './types';

@Injectable()
export class FileService {
  constructor(private readonly failover: FallbackCoreService<StorageOps>) {}

  async upload(key: string, data: Buffer) {
    return this.failover.executeOp('upload', { key, data });
  }

  async presign(key: string) {
    return this.failover.executeOp('presign', { key, expiresIn: 3600 }, { providerNames: ['s3', 'gcs'] });
  }
}
```

---

## Core Concepts

### Operation Shapes

```ts
export type OpShape<I = unknown, O = unknown> = { in: I; out: O };
```

Define a **map** of operation names to `{ in, out }` to get precise typing per operation.

### MultiOpProvider Interface

```ts
export interface MultiOpProvider<Ops extends Record<string, OpShape>> {
  name: string;
  capabilities: {
    [K in keyof Ops]: (input: Ops[K]['in']) => Promise<Ops[K]['out']>;
  };
  beforeExecuteOp?<K extends keyof Ops>(op: K, input: Ops[K]['in']): void | Promise<void>;
  afterExecuteOp?<K extends keyof Ops>(op: K, input: Ops[K]['in'], output: Ops[K]['out']): void | Promise<void>;
}
```

> Note: Each provider’s `name` must be unique. It’s used for filtering, policy resolution (`perProvider`), logs, and error aggregation. Duplicate names may cause confusing behavior.

### FallbackCoreModule Options

```ts
export type BackoffKind =
  | 'none'
  | 'linear'
  | 'exp'
  | 'fullJitter'
  | 'equalJitter'
  | 'decorrelatedJitter'
  | 'fibonacci';

export type RetryPolicy = {
  maxRetry?: number;     // default 0
  baseDelayMs?: number;  // default 200
  maxDelayMs?: number;   // default 5000
  backoff?: BackoffKind; // default 'fullJitter'
};

export type PolicyConfig<OpNames extends string = string> = {
  default?: RetryPolicy;
  perOp?: Partial<Record<OpNames, RetryPolicy>>;
  perProvider?: Record<string, RetryPolicy>;
};

export type FallbackCoreOptions<Ops extends Record<string, OpShape> = any> = {
  providers: Array<
    | { provider: MultiOpProvider<Ops>; policy?: RetryPolicy }   // v2
    | { provider: IProvider<any, any>; policy?: RetryPolicy }    // legacy (v1)
  >;
  policy?: PolicyConfig<keyof Ops & string>;
  hooks?: {
    onProviderSuccess?: (ctx: { provider: string; op?: string; attempt: number; durationMs: number; delayMs?: number }, input: unknown, output: unknown) => void | Promise<void>;
    onProviderFail?:    (ctx: { provider: string; op?: string; attempt: number; durationMs: number; delayMs?: number }, input: unknown, error: unknown) => void | Promise<void>;
    onAllFailed?:       (ctx: { op?: string }, input: unknown, errors: ProviderAttemptError[]) => void | Promise<void>;
  };
};
```

### Policy Resolution Precedence

Effective retry policy is computed with priority:

```
perProvider[providerName] > perOp[opName] > provider.inlinePolicy > policy.default
```

Missing fields cascade to lower priority and finally to defaults:
`maxRetry=0`, `baseDelayMs=200`, `maxDelayMs=5000`, `backoff='fullJitter'`.

---

## API Reference

### `executeOp`

```ts
executeOp<K extends keyof Ops>(
  op: K,
  input: Ops[K]['in'],
  options?: { providerNames?: string[] }
): Promise<Ops[K]['out']>;
```

* **Sequential**: tries providers in the configured order.
* Applies per-provider retry with backoff.
* Skips providers that **don’t implement** `op`.
* Stops on first success; throws `AllProvidersFailedError` if all failed.

### `executeAnyOp`

```ts
executeAnyOp<K extends keyof Ops>(
  op: K,
  input: Ops[K]['in'],
  options?: { providerNames?: string[] }
): Promise<Ops[K]['out']>;
```

* **Parallel-any**: runs all eligible providers concurrently (each with its retry loop).
* Resolves with the **first** success; rejects with `AllProvidersFailedError` if none succeed.

### `executeAllOp`

```ts
executeAllOp<K extends keyof Ops>(
  op: K,
  input: Ops[K]['in'],
  options?: { providerNames?: string[] }
): Promise<Array<
  { provider: string; ok: true; value: Ops[K]['out'] } |
  { provider: string; ok: false; error: unknown }
>>;
```

* **Parallel-all**: runs all eligible providers concurrently.
* Returns **all** outcomes (no throw).

### Legacy APIs (Deprecated)

These remain for backward compatibility and internally route via a `'default'` operation using a legacy adapter:

* `execute(input)`
* `executeAny(input)`
* `executeAll(input)`
* `executeWithFilter(input, providerNames, mode)`

Prefer using **`executeOp` / `executeAnyOp` / `executeAllOp`**.

---

## Retry & Backoff

### Algorithms

Supported `backoff` kinds:

| Kind                 | Formula (cap by `maxDelayMs`)      | Notes                                |
| -------------------- | ---------------------------------- | ------------------------------------ |
| `none`               | `0`                                | No delay between retries             |
| `linear`             | `base * attempt`                   | Simple, predictable                  |
| `exp`                | `base * 2^(attempt-1)`             | Classic exponential                  |
| `fullJitter`         | `random(0, base * 2^(attempt-1))`  | Recommended default; avoids herds    |
| `equalJitter`        | `baseExp/2 + random(0, baseExp/2)` | Softer jitter                        |
| `decorrelatedJitter` | `random(base, prevDelay * 3)`      | Great for flaky networks             |
| `fibonacci`          | `base * Fib(attempt)`              | Middle ground between linear and exp |

### Respecting Retry-After

If a provider error includes `retryAfterMs` **or** HTTP `Retry-After` header, the next delay **overrides** the computed backoff.

Servers may send `Retry-After` as either seconds or an HTTP-date. This library first tries to parse a number (seconds); if it’s a date, you should convert it to milliseconds and attach as `error.retryAfterMs` on your error before rethrowing.

```ts
function retryAfterToMs(value: string): number | undefined {
  const secs = Number(value);
  if (!Number.isNaN(secs)) return secs * 1000;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}
```

### Choosing a Strategy

* Default: **`fullJitter`** with `baseDelayMs=200`, `maxDelayMs=5000`, `maxRetry=3`.
* Network-heavy ops (upload/download): `decorrelatedJitter` or `fullJitter`.
* Lightweight ops (presign/metadata): `linear` with small `maxRetry`.

```ts
// Tune upload heavier than presign, and tweak a specific provider
policy: {
  default: { maxRetry: 2, baseDelayMs: 200, maxDelayMs: 5000, backoff: 'fullJitter' },
  perOp: {
    upload:  { maxRetry: 4, baseDelayMs: 250, backoff: 'decorrelatedJitter' },
    presign: { maxRetry: 1, baseDelayMs: 100, backoff: 'linear' },
  },
  perProvider: {
    gcs: { maxRetry: 3, baseDelayMs: 300 }, // overrides above for GCS
  },
}
```

---

## Hooks & Telemetry

Global hooks receive context including provider, op, attempt, duration, and `delayMs` (if retrying):

```ts
hooks: {
  onProviderSuccess: ({ provider, op, attempt, durationMs }) => {},
  onProviderFail:    ({ provider, op, attempt, durationMs, delayMs }) => {},
  onAllFailed:       ({ op }, input, attempts) => {},
}
```

Use these to export metrics (e.g., Prometheus/OpenTelemetry) or attach structured logs.

---

## Examples

### StorageOps: upload, download, presign

```ts
export type StorageOps = {
  upload:   OpShape<{ key: string; data: Buffer }, { key: string; url?: string }>;
  download: OpShape<{ key: string }, { stream: NodeJS.ReadableStream }>;
  presign:  OpShape<{ key: string; expiresIn?: number }, { url: string }>;
};
```

Three providers implementing different cloud SDKs (`S3Provider`, `R2Provider`, `GCSProvider`) expose the same capabilities.

### Sequential with Priority & Retry

```ts
const out = await failover.executeOp('upload', { key: 'a.txt', data: buf });
// Tries S3 -> R2 -> GCS, with per-provider retry and backoff
```

### Parallel Any (Fastest Success)

```ts
const stream = await failover.executeAnyOp('download', { key: 'a.txt' });
// Resolves with the first provider that returns successfully
```

> Cancellation: When the first provider succeeds, other in-flight attempts are ignored best-effort. Depending on your SDK, you can wire an `AbortController` inside your provider to cancel underlying requests.

```ts
// Inside a provider method:
const ac = new AbortController();
try {
  const res = await fetch(url, { signal: ac.signal });
  return await res.json();
} finally {
  // expose a cancel hook if your runtime supports it
}
```

### Parallel All (Health Fanout)

```ts
const res = await failover.executeAllOp('presign', { key: 'a.txt', expiresIn: 3600 });
// Inspect success/failure of every provider
```

### Filtering Providers

```ts
await failover.executeOp('presign', { key: 'a.txt' }, { providerNames: ['s3', 'gcs'] });
```

```ts
// Without filter; all capable providers are considered automatically
await failover.executeOp('presign', { key: 'a.txt' });
```

> Tip: Filtering by `providerNames` narrows candidates before capability checks. If you pass a name that doesn’t implement the `op`, it will be skipped. If all filtered providers are incompatible, you’ll get `AllProvidersFailedError` quickly.

---

## Migration from v1

v1 exposed a single-operation `IProvider<Input, Output>` with methods like `execute`, `executeAny`, `executeAll`.

In v2:

* Prefer **MultiOpProvider** and **`executeOp/AnyOp/AllOp`**.
* Legacy usage continues to work, but is **deprecated**.

### Adapting a v1 Provider

Wrap a legacy provider to a `'default'` op:

```ts
import { wrapLegacyAsMultiOp } from '@calumma/nest-failover';

const legacy = { name: 'old', execute: async (input: In): Promise<Out> => {/*...*/} };
const v2provider = wrapLegacyAsMultiOp(legacy, 'default');
```

Then call:

```ts
await failover.executeOp('default' as any, input);
```

Or convert to a proper MultiOpProvider by defining explicit ops.

```ts
// If you want type safety without 'as any':
type LegacyOps = { default: OpShape<In, Out> };
const wrapped = wrapLegacyAsMultiOp<In, Out>(legacy, 'default');
// register `wrapped` in FallbackCoreModule.forRoot<LegacyOps>(...)
await failover.executeOp<'default'>('default', input);
```

> You can also keep calling `execute`/`executeAny`/`executeAll`; they route through a `'default'` op internally. Prefer `executeOp` for new code.

---

## Error Model

When all providers fail:

```ts
export class AllProvidersFailedError extends Error {
  constructor(
    public readonly op: string | undefined,
    public readonly attempts: ProviderAttemptError[]
  ) { super(`All providers failed${op ? ` for op "${op}"` : ''}`); }
}

export type ProviderAttemptError = {
  provider: string;
  op?: string;
  attempt: number;
  error: unknown;
};
```

* `executeOp` / `executeAnyOp` throw `AllProvidersFailedError`.
* `executeAllOp` **never throws**; returns `{ ok: false, error }` entries.

---

## Performance Tips

* Tune **per-op** and **per-provider** policy: uploads can retry more than presign.
* Use **parallel-any** for latency-sensitive reads (e.g., nearest region/CDN).
* Add a lightweight **circuit-breaker** outside (e.g., mark provider unhealthy after repeated failures) if needed.
* Use hooks to track **p50/p95** and success rates per provider/op.

---

## Testing

Create fake providers that deterministically fail/succeed to validate sequencing and backoff:

```ts
class FlakyProvider implements MultiOpProvider<StorageOps> {
  name = 'flaky';
  private count = 0;
  capabilities = {
    upload: async (i) => {
      this.count++;
      if (this.count < 3) throw Object.assign(new Error('ETEMP'), { code: 'ETEMP' });
      return { key: i.key };
    },
    download: async () => { throw new Error('not-impl'); },
    presign: async () => ({ url: 'https://example.com' }),
  };
}
```

Use `executeOp('upload', ...)` and assert number of attempts/hook calls. For backoff tests, stub timers or inject a time provider.

---

## Troubleshooting & FAQ

**Q: How do I skip providers that don’t support an operation?**
A: You don’t need to. The service automatically filters to providers that define the capability for that `op`.

**Q: Can I honor `Retry-After` from HTTP 429/503?**
A: Yes. If an error includes `retryAfterMs` or an HTTP `Retry-After` header, that delay overrides backoff.

**Q: How do I run only a subset of providers?**
A: Use `{ providerNames: [...] }` option.

**Q: Does parallel-any cancel other in-flight providers?**
A: The first success **wins**; other results are ignored best-effort. Depending on your SDKs, you may optionally cancel requests.

**Q: What Node/Nest versions are supported?**
A: Node 16+ and NestJS 9+. TypeScript is recommended with `strict` mode.

---

## TypeScript Notes

* Prefer defining ops via `OpShape` map to get precise inference.
* `executeOp('upload', ...)` infers output type specific to `upload`.
* For legacy code, consider migration to MultiOpProvider for better types.

---

## Versioning

* v2 introduces MultiOpProvider and per-op APIs.
* v1 APIs are deprecated but still supported through adapters.
* See releases for detailed changelogs.

## Environment Support

- Node.js: 16+ (tested on 16/18/20)
- NestJS: 9+
- TypeScript: 5+ (`strict` recommended)
- Module formats: ESM & CJS

---

## Contributing

Issues and PRs are welcome. Please include tests for new features and maintain 100% type coverage in public APIs.

---

## License

MIT © [Calumma](https://github.com/calummacc)

