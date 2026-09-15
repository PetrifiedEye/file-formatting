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
 * XML Names, narrowed to the ASCII range actually reachable from JSON keys in
 * practice. A name outside it is sanitized rather than rejected (§4.8).
 */
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const XML_NAME_START = /[A-Za-z_]/;
const XML_NAME_INVALID = /[^A-Za-z0-9._-]/g;

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function scalarText(value: null | boolean | number | string): string {
  return value === null ? '' : String(value);
}

/**
 * XML ↔ the document model.
 *
 * The single-vs-repeated asymmetry in §3.5 is real and deliberate: a one-item
 * list in XML is indistinguishable from a scalar, so `XML → JSON` cannot know
 * it was a list. Wrapping every element in an array would be equally
 * deterministic and would make the common case unusable.
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
    // No entity is ever expanded. `fast-xml-parser` implements no DTD
    // resolution at all and this module constructs no network client, so
    // "no external entity is resolved" is structural, not merely configured
    // (FR-018, SC-007).
    processEntities: false,
    // Leaf values stay strings, for the reason in §1.4.
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

    // The document element becomes the single key of the root object (§3.3).
    return { [names[0]]: this.normalize(root[names[0]]) };
  }

  async write(node: DocumentNode): Promise<Buffer> {
    const body = this.writeDocument(node);

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
   * An element's parsed form onto the model (§3.4 – §3.6).
   *
   * `fast-xml-parser` already gives arrays for repeated siblings and collapses
   * a childless, attribute-free element to its text; what is left is to make an
   * empty element `""` rather than an empty object, and to keep every leaf a
   * string.
   */
  private normalize(value: unknown): DocumentNode {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalize(item));
    }

    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);

      if (entries.length === 0) {
        return '';
      }

      const result: { [key: string]: DocumentNode } = {};
      for (const [key, child] of entries) {
        result[key] = this.normalize(child);
      }
      return result;
    }

    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  private writeDocument(node: DocumentNode): string {
    // A root array becomes <root><item>…</item></root> (§4.3).
    if (Array.isArray(node)) {
      return this.element(
        DEFAULT_DOCUMENT_ELEMENT,
        Object.fromEntries([[ARRAY_ITEM_ELEMENT, node]]),
      );
    }

    if (node !== null && typeof node === 'object') {
      const keys = Object.keys(node);

      // A single valid-XML-Name key is the document element (§4.2).
      if (keys.length === 1 && XML_NAME.test(keys[0])) {
        return this.element(keys[0], node[keys[0]]);
      }

      return this.element(DEFAULT_DOCUMENT_ELEMENT, node);
    }

    return this.element(DEFAULT_DOCUMENT_ELEMENT, node);
  }

  /** One element and everything under it. */
  private element(name: string, value: DocumentNode): string {
    if (Array.isArray(value)) {
      // An array emits its owning key once per item — the inverse of §3.5.
      return value.map((item) => this.element(name, item)).join('');
    }

    if (value === null) {
      // `null` becomes an empty element (§4.6).
      return `<${name}/>`;
    }

    if (typeof value !== 'object') {
      const text = escapeText(scalarText(value));
      return text === '' ? `<${name}/>` : `<${name}>${text}</${name}>`;
    }

    const attributes: string[] = [];
    const children: string[] = [];
    let text = '';

    for (const [childName, childValue] of this.sanitizedEntries(value)) {
      if (childName.startsWith(ATTRIBUTE_PREFIX)) {
        const attributeName = childName.slice(ATTRIBUTE_PREFIX.length);
        attributes.push(
          ` ${attributeName}="${escapeAttribute(
            scalarText(childValue as null | boolean | number | string),
          )}"`,
        );
        continue;
      }

      if (childName === TEXT_KEY) {
        text = escapeText(
          scalarText(childValue as null | boolean | number | string),
        );
        continue;
      }

      children.push(this.element(childName, childValue));
    }

    const open = `<${name}${attributes.join('')}`;
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
