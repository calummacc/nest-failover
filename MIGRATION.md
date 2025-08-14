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

