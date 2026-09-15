import { ConversionException } from '../conversion.exception';
import { DocumentNode, guardStructure } from './document-node';

const limits = { maxDepth: 4, maxNodes: 10 };

function nest(depth: number): DocumentNode {
  let node: DocumentNode = 'leaf';
  for (let i = 1; i < depth; i += 1) {
    node = { child: node };
  }
  return node;
}

describe('guardStructure', () => {
  describe('depth', () => {
    it('accepts a document exactly at the limit', () => {
      expect(() => guardStructure(nest(4), limits)).not.toThrow();
    });

    it('refuses a document one level over the limit', () => {
      expect(() => guardStructure(nest(5), limits)).toThrow(
        ConversionException,
      );
    });

    it('names the depth limit in the refusal', () => {
      try {
        guardStructure(nest(5), limits);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ConversionException);
        const exception = error as ConversionException;
        expect(exception.code).toBe('structure_limit_exceeded');
        expect(exception.getStatus()).toBe(400);
        expect((exception.getResponse() as { message: string }).message).toBe(
          'Input nesting exceeds the maximum depth of 4',
        );
      }
    });

    it('counts array nesting the same as object nesting', () => {
      // Three arrays around a scalar is four levels, exactly like nest(4).
      expect(() => guardStructure([[['deep']]], limits)).not.toThrow();
      expect(() => guardStructure([[[['deeper']]]], limits)).toThrow(
        ConversionException,
      );
    });
  });

  describe('node count', () => {
    it('accepts a document exactly at the limit', () => {
      // The array plus nine elements is ten nodes.
      const node = [1, 2, 3, 4, 5, 6, 7, 8, 9];
      expect(() => guardStructure(node, limits)).not.toThrow();
    });

    it('refuses a document one node over the limit', () => {
      const node = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      expect(() => guardStructure(node, limits)).toThrow(ConversionException);
    });

    it('names the node limit in the refusal', () => {
      try {
        guardStructure([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], limits);
        throw new Error('expected a refusal');
      } catch (error) {
        const exception = error as ConversionException;
        expect((exception.getResponse() as { message: string }).message).toBe(
          'Input exceeds the maximum of 10 nodes',
        );
      }
    });

    it('counts object keys, not just values', () => {
      const node = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 };
      expect(() => guardStructure(node, limits)).not.toThrow();
      expect(() => guardStructure({ ...node, j: 10 }, limits)).toThrow(
        ConversionException,
      );
    });
  });

  describe('documents that are empty but valid', () => {
    // These are successes, not errors: only a zero-byte upload is an error.
    it.each([
      ['null', null],
      ['a boolean', true],
      ['a number', 42],
      ['a string', 'text'],
      ['an empty array', []],
      ['an empty object', {}],
    ] as [string, DocumentNode][])('accepts %s', (_label, node) => {
      expect(() => guardStructure(node, limits)).not.toThrow();
    });
  });

  it('does not overflow the call stack on pathological nesting', () => {
    // The walk keeps its own stack precisely so this is a refusal rather than
    // a RangeError.
    expect(() => guardStructure(nest(50000), limits)).toThrow(
      ConversionException,
    );
  });
});
