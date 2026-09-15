import { DocumentNode } from './document-node';
import {
  expand,
  escapeSegment,
  flatten,
  splitPath,
  unescapeSegment,
} from './flatten';

function paths(node: DocumentNode): Record<string, DocumentNode> {
  return Object.fromEntries(flatten(node));
}

describe('flatten', () => {
  it('appends ".<key>" for an object step', () => {
    expect(paths({ user: { name: 'Ann' } })).toEqual({ 'user.name': 'Ann' });
  });

  it('appends ".<index>" for an array step, 0-based', () => {
    expect(paths({ tags: ['a', 'b'] })).toEqual({
      'tags.0': 'a',
      'tags.1': 'b',
    });
  });

  it('flattens the worked example from the mapping rules', () => {
    expect(paths({ id: 1, user: { name: 'Ann' }, tags: ['a', 'b'] })).toEqual({
      id: 1,
      'user.name': 'Ann',
      'tags.0': 'a',
      'tags.1': 'b',
    });
  });

  it('keeps key order', () => {
    expect([...flatten({ b: 1, a: 2, c: 3 }).keys()]).toEqual(['b', 'a', 'c']);
  });

  it('keeps null as a value, not as a missing path', () => {
    expect(paths({ meta: null })).toEqual({ meta: null });
  });

  it('emits no column for an empty array or object', () => {
    // CSV cannot spell "an empty list lived here", and inventing a spelling
    // would break the round trip the other way.
    expect(paths({ tags: [], meta: {}, id: 1 })).toEqual({ id: 1 });
  });

  it('escapes a literal dot inside a key', () => {
    expect(paths({ 'a.b': 1 })).toEqual({ 'a\\.b': 1 });
  });

  it('distinguishes a dotted key from a nested one', () => {
    expect(Object.keys(paths({ 'a.b': 1 }))).not.toEqual(
      Object.keys(paths({ a: { b: 1 } })),
    );
  });

  it('escapes a literal backslash', () => {
    expect(paths({ 'a\\b': 1 })).toEqual({ 'a\\\\b': 1 });
  });

  it('flattens a bare scalar to the empty path', () => {
    expect(paths('value')).toEqual({ '': 'value' });
  });
});

describe('splitPath', () => {
  it('splits on unescaped dots', () => {
    expect(splitPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('does not split on an escaped dot', () => {
    expect(splitPath('a\\.b.c')).toEqual(['a.b', 'c']);
  });

  it('unescapes a backslash', () => {
    expect(splitPath('a\\\\b')).toEqual(['a\\b']);
  });
});

describe('escapeSegment / unescapeSegment', () => {
  it.each(['plain', 'a.b', 'a\\b', 'a\\.b', '.', '\\'])(
    'round-trips %j',
    (segment) => {
      expect(unescapeSegment(escapeSegment(segment))).toBe(segment);
    },
  );
});

describe('flatten → expand', () => {
  const cases: [string, DocumentNode][] = [
    ['a flat object', { a: 1, b: 'two' }],
    ['a nested object', { user: { name: 'Ann', address: { city: 'Rome' } } }],
    ['an array of scalars', { tags: ['a', 'b', 'c'] }],
    ['an array of objects', { rows: [{ a: 1 }, { a: 2 }] }],
    ['mixed nesting', { id: 1, user: { name: 'Ann' }, tags: ['a', 'b'] }],
    ['a null value', { meta: null }],
    ['a dotted key', { 'a.b': 1 }],
    ['a backslashed key', { 'a\\b': 1 }],
    ['a dotted key beside a nested one', { 'a.b': 1, a: { c: 2 } }],
    ['booleans and numbers', { yes: true, no: false, n: 1.5 }],
  ];

  it.each(cases)('round-trips %s', (_label, node) => {
    expect(expand(flatten(node))).toEqual(node);
  });

  it('rebuilds arrays as arrays, not as index-keyed objects', () => {
    const rebuilt = expand(flatten({ tags: ['a', 'b'] })) as {
      tags: unknown;
    };

    expect(Array.isArray(rebuilt.tags)).toBe(true);
  });

  it('rebuilds a bare scalar', () => {
    expect(expand(flatten('value'))).toBe('value');
  });

  it('yields an empty object for no paths', () => {
    expect(expand(new Map())).toEqual({});
  });
});
