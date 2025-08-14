/** Small helpers for computing and awaiting retry backoff delays. */

export type BackoffKind =
  | 'none'
  | 'linear'
  | 'exp'
  | 'fullJitter'
  | 'equalJitter'
  | 'decorrelatedJitter'
  | 'fibonacci';

/** Wait for a given number of milliseconds. */
export async function sleep(ms: number): Promise<void> {
  await new Promise(res => setTimeout(res, ms));
}

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Compute the delay for a given attempt using the specified backoff strategy.
 */
export function computeDelayMs(opts: {
  kind: BackoffKind;
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  prevDelayMs?: number;
}): number {
  const base = Math.max(0, opts.baseDelayMs ?? 200);
  const cap = Math.max(base, opts.maxDelayMs ?? 5000);
  const n = Math.max(1, opts.attempt);
  const prev = Math.max(0, opts.prevDelayMs ?? base);

  const clamp = (v: number) => Math.min(cap, Math.max(0, Math.floor(v)));

  switch (opts.kind) {
    case 'none':
      return 0;
    case 'linear':
      return clamp(base * n);
    case 'exp':
      return clamp(base * Math.pow(2, n - 1));
    case 'fullJitter':
      return randInt(0, clamp(base * Math.pow(2, n - 1)));
    case 'equalJitter': {
      const d = clamp(base * Math.pow(2, n - 1));
      const half = Math.floor(d / 2);
      return half + randInt(0, Math.max(0, d - half));
    }
    case 'decorrelatedJitter': {
      const d = randInt(base, Math.max(base, prev * 3));
      return clamp(d);
    }
    case 'fibonacci': {
      let a = 1, b = 1;
      for (let i = 2; i < n; i++) { const t = a + b; a = b; b = t; }
      const fib = n <= 2 ? 1 : b;
      return clamp(base * fib);
    }
    default:
      return clamp(base * n);
  }
}


