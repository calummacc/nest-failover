import { IProvider, MultiOpProvider, OpShape } from './types';

/**
 * Adapter that wraps a legacy single-operation provider into a v2 multi-operation provider.
 * The single capability is exposed under the provided `opName` (default: 'default').
 */
export function wrapLegacyAsMultiOp<In, Out>(
  p: IProvider<In, Out>,
  opName: string = 'default',
): MultiOpProvider<Record<string, OpShape>> {
  const name = p.name ?? opName;
  return {
    name,
    capabilities: {
      [opName]: (input: In) => p.execute(input),
    },
  } as MultiOpProvider<Record<string, OpShape>>;
}


