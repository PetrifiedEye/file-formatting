import { ConversionErrorCode } from '../conversion.constants';
import { ConversionException } from '../conversion.exception';

/**
 * The canonical document — the hub every format reads into and writes from.
 *
 * It is deliberately the RFC 8259 data model. JSON is exact against it, YAML
 * 1.2's core schema maps onto it losslessly, and CSV and XML map onto it
 * through the rules in `README.md`. A richer model (ordered maps, typed
 * scalars, XML namespaces) would buy fidelity only for XML→XML, which is not a
 * supported direction.
 */
export type DocumentNode =
  | null
  | boolean
  | number
  | string
  | DocumentNode[]
  | { [key: string]: DocumentNode };

/**
 * The structural limits, as the guard needs them. `ConversionLimits` satisfies
 * this structurally, so the guard does not depend on the handler contract.
 */
export interface StructureLimits {
  maxDepth: number;
  maxNodes: number;
}

/**
 * Refuse a document that is too deep or too large, once, for every format.
 *
 * This runs on the model rather than on the wire form, which is what lets one
 * walk cover all four sources: a 200-level structure is equally hostile whether
 * it arrived as JSON braces or XML elements (FR-017).
 *
 * The walk keeps its own stack instead of recursing — the input it is meant to
 * defend against is exactly the input that would overflow the call stack first,
 * and a `RangeError` is not the refusal the contract promises.
 */
export function guardStructure(
  node: DocumentNode,
  limits: StructureLimits,
): void {
  const stack: { node: DocumentNode; depth: number }[] = [{ node, depth: 1 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;

    if (nodes > limits.maxNodes) {
      throw new ConversionException(
        ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED,
        { aspect: 'nodes', limit: limits.maxNodes },
      );
    }

    if (current.depth > limits.maxDepth) {
      throw new ConversionException(
        ConversionErrorCode.STRUCTURE_LIMIT_EXCEEDED,
        { aspect: 'depth', limit: limits.maxDepth },
      );
    }

    const value = current.node;

    if (Array.isArray(value)) {
      for (const child of value) {
        stack.push({ node: child, depth: current.depth + 1 });
      }
    } else if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        stack.push({ node: value[key], depth: current.depth + 1 });
      }
    }
  }
}
