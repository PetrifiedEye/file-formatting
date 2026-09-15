import { DocumentNode } from './document-node';

/**
 * Path keys for CSV columns, and their inverse.
 *
 * An object step appends `.<key>`; an array step appends `.<index>`, 0-based. A
 * literal `.` inside a key is escaped as `\.`, which is what makes the mapping
 * reversible: without it `{"a.b": 1}` and `{"a": {"b": 1}}` would produce the
 * same column and `CSV → JSON` could not tell them apart.
 *
 * `\` itself is escaped as `\\` for the same reason.
 */
export function escapeSegment(segment: string): string {
  return segment.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

export function unescapeSegment(segment: string): string {
  return segment.replace(/\\([\\.])/g, '$1');
}

/** Split a path on unescaped dots. */
export function splitPath(path: string): string[] {
  const segments: string[] = [];
  let current = '';

  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];

    if (char === '\\' && i + 1 < path.length) {
      current += char + path[i + 1];
      i += 1;
      continue;
    }

    if (char === '.') {
      segments.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  segments.push(current);

  return segments.map(unescapeSegment);
}

/**
 * Flatten one row object into `path → scalar` pairs, in document order.
 *
 * An empty array or empty object has no scalar underneath it and therefore
 * contributes no column: CSV has no way to spell "an empty list lived here",
 * and inventing one would break the round trip in the other direction.
 */
export function flatten(node: DocumentNode): Map<string, DocumentNode> {
  const flat = new Map<string, DocumentNode>();

  const walk = (value: DocumentNode, prefix: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, prefix === '' ? String(index) : `${prefix}.${index}`);
      });
      return;
    }

    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const escaped = escapeSegment(key);
        walk(child, prefix === '' ? escaped : `${prefix}.${escaped}`);
      }
      return;
    }

    flat.set(prefix, value);
  };

  walk(node, '');

  return flat;
}

/**
 * Rebuild a nested value from `path → value` pairs.
 *
 * A segment of digits becomes an array index, which is the inverse of the array
 * step above. The consequence is stated in the mapping rules: a key that is
 * itself all digits comes back as an array index, because CSV keeps no type
 * information about the path either.
 */
export function expand(flat: Map<string, DocumentNode>): DocumentNode {
  const root: { value: DocumentNode } = { value: {} };

  for (const [path, value] of flat) {
    const segments = splitPath(path);

    if (segments.length === 1 && segments[0] === '') {
      root.value = value;
      continue;
    }

    let container: DocumentNode = root.value;
    let parent: { set: (node: DocumentNode) => void } = {
      set: (node) => {
        root.value = node;
      },
    };

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const isIndex = /^\d+$/.test(segment);
      const last = i === segments.length - 1;

      if (isIndex) {
        if (!Array.isArray(container)) {
          container = [];
          parent.set(container);
        }
        const index = Number(segment);
        if (last) {
          container[index] = value;
        } else {
          const next: DocumentNode = container[index] ?? {};
          const array = container;
          array[index] = next;
          parent = { set: (node) => (array[index] = node) };
          container = next;
        }
        continue;
      }

      if (
        Array.isArray(container) ||
        container === null ||
        typeof container !== 'object'
      ) {
        container = {};
        parent.set(container);
      }

      const object = container as { [key: string]: DocumentNode };

      if (last) {
        object[segment] = value;
      } else {
        const next: DocumentNode = object[segment] ?? {};
        object[segment] = next;
        parent = { set: (node) => (object[segment] = node) };
        container = next;
      }
    }
  }

  return root.value;
}
