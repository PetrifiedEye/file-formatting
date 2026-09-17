import { XMLParser } from 'fast-xml-parser';

import { ConversionErrorCode } from '@/modules/conversion/conversion.constants';
import { ConversionException } from '@/modules/conversion/conversion.exception';

/** Elements that execute, embed, or fetch. None has a place in a drawing. */
const ACTIVE_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'embed',
  'object',
  'handler',
  'audio',
  'video',
]);

/** Attributes whose value may name a resource. */
const URL_ATTRIBUTES = new Set([
  'href',
  'xlink:href',
  'src',
  'style',
  'fill',
  'stroke',
  'filter',
  'mask',
  'clip-path',
]);

/**
 * Constructs refused on sight, before the document is parsed at all.
 *
 * This is the *first* of two independent checks, and it exists because the two
 * fail differently: the structured walk understands namespaces, CDATA, and
 * attribute nesting that a scan cannot, while the scan catches whatever the
 * parser and the renderer might disagree about. A parser differential is the
 * classic way a sanitizer is bypassed, so a construct would have to be
 * invisible to `fast-xml-parser` *and* invisible to a literal substring scan
 * *and* meaningful to resvg.
 */
const RAW_PATTERNS: { pattern: RegExp; code: RefusalCode }[] = [
  // A DOCTYPE is what closes billion-laughs: no entity expansion is ever
  // performed, so there is no expansion budget to tune and no bomb to survive.
  { pattern: /<!DOCTYPE/i, code: ConversionErrorCode.XML_DOCTYPE_FORBIDDEN },
  { pattern: /<!ENTITY/i, code: ConversionErrorCode.XML_DOCTYPE_FORBIDDEN },
  { pattern: /<script/i, code: ConversionErrorCode.SVG_ACTIVE_CONTENT },
  { pattern: /javascript:/i, code: ConversionErrorCode.SVG_ACTIVE_CONTENT },
  { pattern: /\son[a-z-]+\s*=/i, code: ConversionErrorCode.SVG_ACTIVE_CONTENT },
  { pattern: /@import/i, code: ConversionErrorCode.SVG_EXTERNAL_REFERENCE },
];

type RefusalCode =
  | typeof ConversionErrorCode.XML_DOCTYPE_FORBIDDEN
  | typeof ConversionErrorCode.SVG_ACTIVE_CONTENT
  | typeof ConversionErrorCode.SVG_EXTERNAL_REFERENCE;

const ATTRIBUTE_PREFIX = '@_';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTRIBUTE_PREFIX,
  // Never expand an entity. Combined with the DOCTYPE refusal above this means
  // no entity is ever expanded at any point, by anything.
  processEntities: false,
  allowBooleanAttributes: true,
  // Text nodes are needed: a `<style>` element's `@import` lives in one.
  trimValues: false,
  removeNSPrefix: false,
  preserveOrder: true,
});

export interface ValidatedSvg {
  /** The **original** bytes, decoded. Never re-serialized. */
  text: string;
  /** Root `<svg>` attributes, for the intrinsic-size rule. */
  attributes: Record<string, string>;
}

/**
 * Validate an SVG upload, or refuse it.
 *
 * **This never rewrites the document.** It refuses, or it passes the original
 * text through — a sanitizer that re-serializes creates exactly the parse
 * differential it exists to close, because what was checked would no longer be
 * what is rendered.
 *
 * It is also the only place "no outbound request is made" is enforced *as a
 * rule*; the stronger guarantee is that this module contains no HTTP client
 * and reads no file the document names, so the guarantee is the absence of a
 * code path and this is defence in depth on top of it.
 */
export function validateSvg(input: Buffer): ValidatedSvg {
  const text = decodeUtf8(input);

  for (const { pattern, code } of RAW_PATTERNS) {
    if (pattern.test(text)) {
      throw new ConversionException(code);
    }
  }

  let parsed: unknown;

  try {
    parsed = parser.parse(text) as unknown;
  } catch {
    // A document the parser cannot read is one whose contents we cannot vouch
    // for, and a renderer might still make something of it.
    throw new ConversionException(ConversionErrorCode.SVG_RENDER_FAILED);
  }

  const root = walk(parsed);

  if (!root) {
    throw new ConversionException(ConversionErrorCode.SVG_RENDER_FAILED);
  }

  return { text, attributes: root };
}

/** Round-trip check: anything that does not survive was not valid UTF-8. */
function decodeUtf8(input: Buffer): string {
  const text = input.toString('utf8');

  if (!Buffer.from(text, 'utf8').equals(input)) {
    throw new ConversionException(ConversionErrorCode.INVALID_ENCODING);
  }

  // A BOM is legal and must not reach the renderer as a stray character.
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Walk the parsed document, refusing anything active or external, and return
 * the root `<svg>` element's attributes.
 *
 * `preserveOrder` gives an array of single-key objects per node, which is the
 * shape that keeps repeated sibling elements distinct — a document with three
 * `<image>` elements must have all three examined, not just the last.
 */
function walk(parsed: unknown): Record<string, string> | null {
  let rootAttributes: Record<string, string> | null = null;

  const visit = (nodes: unknown, insideStyle: boolean): void => {
    if (!Array.isArray(nodes)) {
      return;
    }

    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) {
        continue;
      }

      const element = node as Record<string, unknown>;

      for (const [name, value] of Object.entries(element)) {
        if (name === ':@') {
          continue;
        }

        if (name === '#text') {
          if (insideStyle) {
            checkStyleText(String(value));
          }
          continue;
        }

        const local = name.includes(':')
          ? name.slice(name.indexOf(':') + 1)
          : name;

        if (ACTIVE_ELEMENTS.has(local.toLowerCase())) {
          throw new ConversionException(ConversionErrorCode.SVG_ACTIVE_CONTENT);
        }

        const attributes = readAttributes(element);

        checkAttributes(attributes);

        if (rootAttributes === null && local.toLowerCase() === 'svg') {
          rootAttributes = attributes;
        }

        visit(value, local.toLowerCase() === 'style');
      }
    }
  };

  visit(parsed, false);

  return rootAttributes;
}

function readAttributes(node: Record<string, unknown>): Record<string, string> {
  const raw = node[':@'];

  if (typeof raw !== 'object' || raw === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key.startsWith(ATTRIBUTE_PREFIX)
        ? key.slice(ATTRIBUTE_PREFIX.length)
        : key,
      String(value),
    ]),
  );
}

function checkAttributes(attributes: Record<string, string>): void {
  for (const [name, value] of Object.entries(attributes)) {
    const lower = name.toLowerCase();

    // Any event handler, whatever the renderer does or does not do with it.
    if (lower.startsWith('on')) {
      throw new ConversionException(ConversionErrorCode.SVG_ACTIVE_CONTENT);
    }

    if (/javascript:/i.test(value)) {
      throw new ConversionException(ConversionErrorCode.SVG_ACTIVE_CONTENT);
    }

    if (URL_ATTRIBUTES.has(lower) || lower.startsWith('marker')) {
      checkReference(lower, value);
    }
  }
}

/**
 * A reference must be same-document or inline, and nothing else.
 *
 * `http:`, `https:`, `file:`, protocol-relative `//host`, and plain relative
 * paths are all refused — the last one in particular, because a relative path
 * is what a naive renderer resolves against the filesystem.
 */
function checkReference(name: string, value: string): void {
  // `href`-like attributes hold a bare reference; the presentation ones hold
  // CSS in which references appear as `url(...)`.
  const direct = name === 'href' || name === 'xlink:href' || name === 'src';

  if (direct) {
    if (!isSafeReference(value)) {
      throw new ConversionException(ConversionErrorCode.SVG_EXTERNAL_REFERENCE);
    }
    return;
  }

  checkStyleText(value);
}

/** Every `url(...)` in a CSS fragment, plus `@import` in any form. */
function checkStyleText(css: string): void {
  if (/@import/i.test(css)) {
    throw new ConversionException(ConversionErrorCode.SVG_EXTERNAL_REFERENCE);
  }

  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!isSafeReference(match[2])) {
      throw new ConversionException(ConversionErrorCode.SVG_EXTERNAL_REFERENCE);
    }
  }
}

/**
 * Same-document fragments and inline `data:` URIs pass; everything else does
 * not.
 *
 * An allow-list rather than a deny-list of schemes: a deny-list has to
 * anticipate every scheme a renderer might understand, and the set of safe
 * ones is exactly two.
 */
function isSafeReference(value: string): boolean {
  const reference = value.trim();

  if (reference === '') {
    return true;
  }

  if (reference.startsWith('#')) {
    return true;
  }

  return /^data:/i.test(reference);
}
