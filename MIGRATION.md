# Migration guide: v1 → v2

This guide helps you move from the single-operation v1 API to the multi-operation v2 API while keeping backward compatibility. The v1 methods are still available but marked as deprecated.

## What changed

- Providers can now implement multiple operations with type-safe inputs/outputs using `MultiOpProvider`.
- New methods on `FallbackCoreService`:
  - `executeOp(op, input, options?)` — sequential failover per operation
  - `executeAnyOp(op, input, options?)` — parallel any per operation
  - `executeAllOp(op, input, options?)` — parallel all per operation
- Retry/backoff policies can be configured globally, per operation, and per provider.
- Hooks include `op`, `attempt`, `durationMs`, and `provider` for better telemetry.

## Mapping v1 → v2

- `FallbackCoreService.execute(input)` → `executeOp('<op-name>', input)`
- `FallbackCoreService.executeAny(input, providerNames?)` → `executeAnyOp('<op-name>', input, { providerNames })`
- `FallbackCoreService.executeAll(input, providerNames?)` → `executeAllOp('<op-name>', input, { providerNames })`
- `executeWithFilter(input, providerNames, mode)` → `executeOp`/`executeAnyOp` with `{ providerNames }`

### Detailed migration: `executeWithFilter` (v1) → v2

v1 signature:

```ts
// v1
executeWithFilter(
  input: Input,
  providerNames: string[],
  mode: 'sequential' | 'parallel',
): Promise<unknown>;
```

In v2 there is no `mode` parameter. You choose the strategy by calling the corresponding method and pass the same `providerNames` via options:

- sequential failover → `executeOp`
- parallel-any (first success) → `executeAnyOp`
- parallel-all (collect outcomes) → `executeAllOp`

Notes on shapes and behavior:
- v1 `mode: 'sequential'` could return `{ provider, result }`. In v2, `executeOp` returns the successful result directly (`result` only). If you need the winning provider for telemetry, use hooks (see below).
- v1 `mode: 'parallel'` in many codebases was used either to mean "first to succeed" or "all outcomes". In v2 this is explicit:
  - first success: `executeAnyOp`
  - all outcomes: `executeAllOp` (returns an array of `{ provider, ok, value|error }`)

#### Example: sequential subset (v1 → v2)

```ts
// v1
await service.executeWithFilter(input, ['s3', 'gcs'], 'sequential');

// v2 (pick your real operation name, e.g., 'upload')
await service.executeOp('upload', input, { providerNames: ['s3', 'gcs'] });
```

Return shape difference (v2): you get the operation output only. If you must know the winner, capture it via hooks:

```ts
// during module setup
FallbackCoreModule.forRoot<Ops>({
  providers: [/* ... */],
  hooks: {
    onProviderSuccess: ({ provider, op }) => {
      // record who won (e.g., to a request-scoped logger/metrics)
    },
  },
});
```

#### Example: parallel-any subset (v1 → v2)

```ts
// v1 (some projects used 'parallel' to mean first success)
await service.executeWithFilter(input, ['s3', 'gcs'], 'parallel');

// v2 (first to succeed wins)
await service.executeAnyOp('upload', input, { providerNames: ['s3', 'gcs'] });
```

#### Example: parallel-all subset (v1 → v2)

```ts
// v1 (if you used 'parallel' to collect outcomes and inspect them later)
// you probably followed up with your own aggregation logic.

// v2
const results = await service.executeAllOp('upload', input, { providerNames: ['s3', 'gcs'] });
// results: Array<
//   | { provider: string; ok: true; value: UploadOut }
//   | { provider: string; ok: false; error: unknown }
// >
```

#### Tip: filtering happens before capability checks

`providerNames` reduces candidates first, then v2 automatically skips providers that don’t implement the requested operation. If you filter to names that are all incompatible with the op, you will hit `AllProvidersFailedError` quickly.

#### Recreating v1 `{ provider, result }` for sequential

v2’s `executeOp` returns only the operation result. If you need the winning provider in the return value (not just via hooks), consider:

- Prefer hooks for telemetry and logs (`onProviderSuccess` includes `{ provider, op, attempt, durationMs }`).
- Or wrap the call yourself and capture the provider via a request-scoped store updated by `onProviderSuccess`.

If your use case is fine with parallel semantics and you only need the identity, you can use `executeAllOp` and pick the first successful entry by your own priority order (note: this changes execution semantics from sequential to parallel):

```ts
const order = ['s3', 'gcs'];
const outcomes = await service.executeAllOp('upload', input, { providerNames: order });
const firstOk = order
  .map(name => outcomes.find(o => o.provider === name && o.ok))
  .find(Boolean) as { provider: string; ok: true; value: UploadOut } | undefined;
if (!firstOk) throw new Error('All failed');
const { provider, value: result } = firstOk;
```


## Providers

### Option A: Implement `MultiOpProvider`

```ts
import { MultiOpProvider, OpShape } from '@calumma/nest-failover';

type MailOps = {
  send: OpShape<{ to: string; subject: string }, { id: string; accepted: boolean }>;
};

export const MailA: MultiOpProvider<MailOps> = {
  name: 'mailA',
  capabilities: {
    send: async (input) => ({ id: 'msg_1', accepted: true }),
  },
};
```

### Option B: Wrap legacy single-op providers

```ts
import { wrapLegacyAsMultiOp } from '@calumma/nest-failover';

const legacy = new MailProviderA(); // implements IProvider<Input, Output>
const multi = wrapLegacyAsMultiOp(legacy, 'send');
```

## Policies

```ts
policy: {
  default: { maxRetry: 0 },
  perOp: { upload: { maxRetry: 2, retryDelayMs: 200, backoff: 'exp' } },
  perProvider: { s3: { backoff: 'jitteredExp' } },
}
```

Precedence: `perProvider[name] > perOp[op] > entry.policy > policy.default`.

## Hooks

```ts
hooks: {
  onProviderSuccess: (ctx, input, output) => {/* ctx: { provider, op, attempt, durationMs } */},
  onProviderFail:    (ctx, input, error)  => {/* ... */},
  onAllFailed:       (ctx, input, attempts) => {/* attempts: ProviderAttemptError[] */},
}
```

## Backward compatibility

- v1 module options and providers still work. Internally, legacy providers are adapted under the `default` operation.
- v1 service methods are kept and marked `@deprecated`.

## Example conversion

Before (v1):

```ts
FallbackCoreModule.forRoot<UploadInput, UploadResult>({
  providers: [
    { provider: new S3(), maxRetry: 1, retryDelayMs: 100 },
    { provider: new GCS() },
  ],
});
```

After (v2):

```ts
type StorageOps = { upload: OpShape<UploadInput, UploadResult> };

FallbackCoreModule.forRoot<StorageOps>({
  providers: [
    { provider: wrapLegacyAsMultiOp(new S3(), 'upload') },
    { provider: wrapLegacyAsMultiOp(new GCS(), 'upload') },
  ],
});
```

---

If you need help migrating, open an issue on GitHub.

