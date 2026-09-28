import { Injectable } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  ConversionErrorCode,
  FORMAT_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
} from '../conversion.constants';
import { ConversionFormat } from '../conversion.enums';
import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import type { FormatHandler } from './format-handler';

const ATTRIBUTE_PREFIX = '@_';
const TEXT_KEY = '#text';
const DEFAULT_DOCUMENT_ELEMENT = 'root';
const ARRAY_ITEM_ELEMENT = 'item';

const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * The namespace of the type hints this handler writes (§4.9).
 *
 * Hints are honoured on the way back in only when the document element
 * declares exactly this namespace, so an unrelated document that happens to
 * use an `ff:` prefix — or a caller writing `ff:type` by hand without it — is
 * read like any other XML.
 */
export const XML_TYPES_NAMESPACE = 'urn:file-formatting:xml-types';
const HINT_PREFIX = 'ff';
const HINT_NAMESPACE_KEY = `${ATTRIBUTE_PREFIX}xmlns:${HINT_PREFIX}`;
const HINT_KEY_PREFIX = `${ATTRIBUTE_PREFIX}${HINT_PREFIX}:`;
const TYPE_HINT = `${HINT_KEY_PREFIX}type`;
const ARRAY_HINT = `${HINT_KEY_PREFIX}array`;
const WRAPPED_HINT = `${HINT_KEY_PREFIX}wrapped`;

type TypeHint = 'number' | 'boolean' | 'null' | 'object' | 'array';

/**
 * XML Names, narrowed to the ASCII range actually reachable from JSON keys in
 * practice. A name outside it is sanitized rather than rejected (§4.8).
 */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const XML_NAME_START = /[A-Za-z_]/;
const XML_NAME_INVALID = /[^A-Za-z0-9._-]/g;

/**
 * XML 1.0 §2.2: the C0 controls other than tab, LF and CR, U+FFFE/U+FFFF and
 * unpaired surrogates are not characters at all — not even as a character
 * reference — so no escaping can carry them.
 */
const XML_ILLEGAL_CHARACTER =
  // Matching control characters is this pattern's whole purpose.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Predefined entities and character references, decoded in one pass. */
const XML_REFERENCE = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g;
const PREDEFINED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function refuseUnrepresentable(value: string): string {
  if (XML_ILLEGAL_CHARACTER.test(value)) {
    throw new ConversionException(ConversionErrorCode.XML_UNREPRESENTABLE);
  }
  return value;
}

/**
 * `&`, `<`, `>` — and CR, which a parser's end-of-line handling (§2.11) would
 * otherwise turn into LF on the way back in.
 */
function escapeText(value: string): string {
  return refuseUnrepresentable(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

/**
 * Text escaping plus `"`, and TAB/LF/CR as references: attribute-value
 * normalization (§3.3.3) turns each literal one into a space on the way back
 * in.
 */
function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;');
}

function decodeReferences(value: string): string {
  const decoded = value.replace(
    XML_REFERENCE,
    (match, named: string, decimal: string, hex: string) => {
      if (named) {
        return PREDEFINED_ENTITIES[named];
      }

      const codePoint = decimal ? Number(decimal) : parseInt(hex, 16);

      if (codePoint > 0x10ffff) {
        throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
      }

      return String.fromCodePoint(codePoint);
    },
  );

  // `&#1;` is well-formed as markup but names no XML character.
  if (XML_ILLEGAL_CHARACTER.test(decoded)) {
    throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
  }

  return decoded;
}

function isScalar(
  value: DocumentNode,
): value is null | boolean | number | string {
  return value === null || typeof value !== 'object';
}

/** Tracks whether anything written needed a hint, i.e. the namespace. */
interface WriteContext {
  hinted: boolean;
}

/**
 * XML ↔ the document model.
 *
 * XML has only text, so on its own it cannot say that `30` was a number, that
 * a single `<item>` was a one-item list, or that `<root>` was invented to hold
 * several top-level keys. The writer says so with type hints in a namespace of
 * its own (§4.9), and the reader honours them (§3.8): what this handler writes,
 * it reads back exactly. XML without hints — anyone else's — reads as before:
 * leaves are strings and a name appearing once is not a list (§3.5, §3.7).
 */
@Injectable()
export class XmlHandler implements FormatHandler {
  readonly format = ConversionFormat.XML;
  readonly mediaType = FORMAT_MEDIA_TYPES[ConversionFormat.XML];
  readonly extension = FORMAT_EXTENSIONS[ConversionFormat.XML];
  /**
   * First in the scan, and conclusive: a leading `<` cannot begin any other
   * supported format, so malformed XML is reported as malformed rather than
   * falling through and coming back as "unsupported".
   */
  readonly detectionPriority = 10;
  readonly sniffIsConclusive = true;

  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTRIBUTE_PREFIX,
    textNodeName: TEXT_KEY,
    // No entity is ever expanded by the parser. `fast-xml-parser` implements
    // no DTD resolution at all and this module constructs no network client,
    // so "no external entity is resolved" is structural, not merely configured
    // (FR-018, SC-007). The five predefined entities and character references
    // — which need no DTD — are decoded by `decodeReferences`, in one pass so
    // `&amp;#65;` stays the text `&#65;`.
    processEntities: false,
    // Leaf values stay strings unless a hint says otherwise (§3.7, §3.8).
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    commentPropName: undefined,
    ignorePiTags: true,
  });

  sniff(prefix: string): boolean {
    return prefix.trimStart().startsWith('<');
  }

  async read(input: string): Promise<DocumentNode> {
    this.refuseDoctype(input);

    // `XMLParser.parse` does not validate — it accepts mismatched and
    // unclosed tags and returns a plausible-looking object. FR-006 requires
    // malformed input to be refused, so validation is a separate, explicit
    // step rather than something assumed of the parser.
    const validation = XMLValidator.validate(input);

    if (validation !== true) {
      // The validator's `msg` quotes the offending markup; only its position
      // survives (FR-023, SC-005).
      const { line, col } = validation.err;
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: typeof line === 'number' ? line : undefined,
        column: typeof col === 'number' ? col : undefined,
      });
    }

    let parsed: unknown;
    try {
      parsed = this.parser.parse(input);
    } catch (error) {
      const line = (error as { line?: number }).line;
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: typeof line === 'number' ? line : undefined,
      });
    }

    const root = parsed as Record<string, unknown>;
    const names = Object.keys(root).filter((key) => key !== '?xml');

    if (names.length === 0) {
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
    }

    const documentElement = root[names[0]];
    const hinted =
      isRecord(documentElement) &&
      documentElement[HINT_NAMESPACE_KEY] === XML_TYPES_NAMESPACE;
    const value = this.normalize(documentElement, hinted);

    // A `<root>` this handler invented to hold several keys, a list or a
    // scalar is unwrapped again (§3.8); otherwise the document element
    // becomes the single key of the root object (§3.3).
    if (hinted && documentElement[WRAPPED_HINT] === 'true') {
      return value;
    }

    return { [names[0]]: value };
  }

  async write(node: DocumentNode): Promise<Buffer> {
    const context: WriteContext = { hinted: false };
    let body = this.writeDocument(node, context);

    // Declared once, on the document element, and only if a hint was needed:
    // a document of plain strings is written exactly as before.
    if (context.hinted) {
      body = body.replace(
        /^<([^\s/>]+)/,
        `<$1 xmlns:${HINT_PREFIX}="${XML_TYPES_NAMESPACE}"`,
      );
    }

    return Buffer.from(`${XML_PROLOG}\n${body}\n`, 'utf8');
  }

  /**
   * Refuse any `<!DOCTYPE`, outright (§3.1, FR-018).
   *
   * No entity declaration — external, parameter, or internal — can exist
   * without one, so this single refusal removes the whole class. It is also
   * what makes the defence *observable*: the e2e test asserts a 400 with a
   * named reason rather than trying to assert the absence of a network call.
   */
  private refuseDoctype(input: string): void {
    // The whole document is scanned, not only the prolog. A literal
    // `<!DOCTYPE` elsewhere can only be inside CDATA — legal, but vanishingly
    // rare and not worth a parser-shaped scanner to permit. Escaped text
    // (`&lt;!DOCTYPE`) is unaffected, so ordinary documents that *talk* about
    // doctypes still convert.
    if (/<!DOCTYPE/i.test(input)) {
      throw new ConversionException(ConversionErrorCode.XML_DOCTYPE_FORBIDDEN);
    }
  }

  /**
   * One element's parsed form onto the model (§3.4 – §3.8).
   *
   * `fast-xml-parser` already gives arrays for repeated siblings and collapses
   * a childless, attribute-free element to its text. What is left: make an
   * empty element `""` rather than an empty object, decode references, and —
   * when the document declares the hint namespace — apply the hints.
   */
  private normalize(value: unknown, hinted: boolean): DocumentNode {
    if (value === null || value === undefined) {
      return '';
    }

    if (!isRecord(value)) {
      return decodeReferences(textOf(value));
    }

    let type: string | undefined;
    const content: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      if (
        hinted &&
        (key.startsWith(HINT_KEY_PREFIX) || key === HINT_NAMESPACE_KEY)
      ) {
        if (key === TYPE_HINT) {
          type = String(child);
        }
        continue;
      }
      content[key] = child;
    }

    const text = () => decodeReferences(textOf(content[TEXT_KEY]));

    switch (type as TypeHint | undefined) {
      case 'null':
        return null;
      case 'number': {
        const number = Number(text());
        if (text() === '' || !Number.isFinite(number)) {
          throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
        }
        return number;
      }
      case 'boolean':
        if (text() === 'true' || text() === 'false') {
          return text() === 'true';
        }
        throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
      case 'array': {
        const items = content[ARRAY_ITEM_ELEMENT];
        if (items === undefined) {
          return [];
        }
        return (Array.isArray(items) ? items : [items]).map((item) =>
          this.normalize(item, hinted),
        );
      }
      case 'object':
      case undefined:
        break;
      default:
        // A hint this handler never writes: not a document it can vouch for.
        throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
    }

    const keys = Object.keys(content);

    if (keys.length === 0) {
      return type === 'object' ? {} : '';
    }

    // Only the hint attributes made this an object: it is really text.
    if (type === undefined && keys.length === 1 && keys[0] === TEXT_KEY) {
      return text();
    }

    const result: { [key: string]: DocumentNode } = {};

    for (const [key, child] of Object.entries(content)) {
      if (key.startsWith(ATTRIBUTE_PREFIX) || key === TEXT_KEY) {
        result[key] = decodeReferences(textOf(child));
      } else if (Array.isArray(child)) {
        result[key] = child.map((item) => this.normalize(item, hinted));
      } else if (hinted && isRecord(child) && child[ARRAY_HINT] === 'true') {
        // A one-item list, marked as such by the writer (§3.8).
        result[key] = [this.normalize(child, hinted)];
      } else {
        result[key] = this.normalize(child, hinted);
      }
    }

    return result;
  }

  private writeDocument(node: DocumentNode, context: WriteContext): string {
    if (isRecord(node) && !Array.isArray(node)) {
      const keys = Object.keys(node);

      // A single valid-XML-Name key is the document element (§4.2).
      if (keys.length === 1 && XML_NAME.test(keys[0])) {
        return this.element(keys[0], node[keys[0]], context);
      }
    }

    // Anything else — several keys, a list, a scalar — gets an invented
    // `<root>`, marked so the reader can take it away again (§4.2, §4.3).
    return this.element(
      DEFAULT_DOCUMENT_ELEMENT,
      node,
      context,
      this.hint(context, 'wrapped', 'true'),
    );
  }

  /** ` ff:<name>="<value>"`, noting that the namespace is now needed. */
  private hint(context: WriteContext, name: string, value: string): string {
    context.hinted = true;
    return ` ${HINT_PREFIX}:${name}="${value}"`;
  }

  /**
   * The elements for one key: an array emits the key once per item — the
   * inverse of §3.5 — with a one-item array marked, since a single element is
   * otherwise indistinguishable from a scalar (§4.5, §4.9).
   */
  private elementsFor(
    name: string,
    value: DocumentNode,
    context: WriteContext,
  ): string {
    if (!Array.isArray(value) || value.length === 0) {
      return this.element(name, value, context);
    }

    if (value.length === 1) {
      return this.element(
        name,
        value[0],
        context,
        this.hint(context, 'array', 'true'),
      );
    }

    return value.map((item) => this.element(name, item, context)).join('');
  }

  /** One element and everything under it. */
  private element(
    name: string,
    value: DocumentNode,
    context: WriteContext,
    hints = '',
  ): string {
    if (Array.isArray(value)) {
      // A list that is itself a value — the document, an empty list, a list
      // inside a list — is an element whose `<item>` children are its items.
      const open = `<${name}${this.hint(context, 'type', 'array')}${hints}`;
      if (value.length === 0) {
        return `${open}/>`;
      }
      const items = value
        .map((item) => this.element(ARRAY_ITEM_ELEMENT, item, context))
        .join('');
      return `${open}>${items}</${name}>`;
    }

    if (value === null) {
      // Distinct from `""`, which is an unmarked empty element (§4.6).
      return `<${name}${this.hint(context, 'type', 'null')}${hints}/>`;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return (
        `<${name}${this.hint(context, 'type', typeof value)}${hints}>` +
        `${escapeText(String(value))}</${name}>`
      );
    }

    if (typeof value === 'string') {
      const text = escapeText(value);
      return text === ''
        ? `<${name}${hints}/>`
        : `<${name}${hints}>${text}</${name}>`;
    }

    const attributes: string[] = [];
    const children: string[] = [];
    let text = '';

    const entries = this.sanitizedEntries(value);

    if (entries.length === 0) {
      return `<${name}${this.hint(context, 'type', 'object')}${hints}/>`;
    }

    for (const [childName, childValue] of entries) {
      if (childName.startsWith(ATTRIBUTE_PREFIX) || childName === TEXT_KEY) {
        // An attribute or the text node can only hold text: a list or an
        // object there has no XML form, so it is refused, not stringified.
        if (!isScalar(childValue)) {
          throw new ConversionException(
            ConversionErrorCode.XML_UNREPRESENTABLE,
          );
        }

        const scalar = childValue === null ? '' : String(childValue);

        if (childName === TEXT_KEY) {
          text = escapeText(scalar);
        } else {
          const attributeName = childName.slice(ATTRIBUTE_PREFIX.length);
          attributes.push(` ${attributeName}="${escapeAttribute(scalar)}"`);
        }
        continue;
      }

      children.push(this.elementsFor(childName, childValue, context));
    }

    const open = `<${name}${attributes.join('')}${hints}`;
    const body = `${text}${children.join('')}`;

    return body === '' ? `${open}/>` : `${open}>${body}</${name}>`;
  }

  /**
   * An object's entries with every key made a legal XML Name (§4.8).
   *
   * Sanitization is where data can disappear: `user name` and `user+name` both
   * become `user_name`. Writing one over the other would lose a field with no
   * sign that anything happened, so a collision is refused instead — FR-009
   * requires data that cannot be represented to be refused with an explanation,
   * not dropped.
   *
   * `-` is deliberately **kept**, unlike the illustration in the mapping-rules
   * contract: it is legal in an XML Name after the first character, and
   * rewriting `first-name` to `first_name` would change data that needed no
   * changing. The rule the contract is stating — refuse a collision, never drop
   * a field — is unaffected.
   */
  private sanitizedEntries(value: {
    [key: string]: DocumentNode;
  }): [string, DocumentNode][] {
    const seen = new Set<string>();

    return Object.entries(value).map(([key, child]) => {
      const sanitized = this.sanitizeName(key);

      if (seen.has(sanitized)) {
        throw new ConversionException(ConversionErrorCode.XML_NAME_COLLISION);
      }
      seen.add(sanitized);

      return [sanitized, child];
    });
  }

  private sanitizeName(key: string): string {
    if (key === TEXT_KEY) {
      return key;
    }

    const isAttribute = key.startsWith(ATTRIBUTE_PREFIX);
    const bare = isAttribute ? key.slice(ATTRIBUTE_PREFIX.length) : key;

    let name = bare.replace(XML_NAME_INVALID, '_');

    if (name === '' || !XML_NAME_START.test(name[0])) {
      name = `_${name}`;
    }

    return isAttribute ? `${ATTRIBUTE_PREFIX}${name}` : name;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A parsed leaf as text: the parser yields strings, never objects, here. */
function textOf(value: unknown): string {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
    ? String(value)
    : '';
}
