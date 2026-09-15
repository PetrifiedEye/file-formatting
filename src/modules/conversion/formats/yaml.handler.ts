import { Injectable } from '@nestjs/common';
import { parseAllDocuments, stringify } from 'yaml';

import {
  ConversionErrorCode,
  FORMAT_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
} from '../conversion.constants';
import { ConversionFormat } from '../conversion.enums';
import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import type { FormatHandler } from './format-handler';

/**
 * A 200-byte anchor bomb expands unbounded inside a synchronous call that no
 * timer can interrupt, so the cap is the defence, not the deadline (FR-017).
 */
const MAX_ALIAS_COUNT = 100;

/**
 * Block-mapping key, block-sequence entry, or document marker — the cheap
 * structural signals from the detection order in research §5.
 */
const YAML_SHAPE = /^\s*(-\s|---)|^\s*[^\s#][^\n]*?:(\s|$)/m;

/**
 * YAML, restricted to the **1.2 core schema**.
 *
 * This is `yaml` v2 rather than `js-yaml` for two reasons, both of which are
 * user-visible: `js-yaml` implements YAML 1.1, where `yes`/`no`/`on`/`off` are
 * booleans and `017` is octal, and it offers no alias-expansion cap at all. The
 * spec asks for 1.2 and for bounded expansion, so the library choice is a
 * correctness decision, not a preference.
 */
@Injectable()
export class YamlHandler implements FormatHandler {
  readonly format = ConversionFormat.YAML;
  readonly mediaType = FORMAT_MEDIA_TYPES[ConversionFormat.YAML];
  readonly extension = FORMAT_EXTENSIONS[ConversionFormat.YAML];
  readonly detectionPriority = 30;
  readonly sniffIsConclusive = false;

  sniff(prefix: string, namedByFileName: boolean): boolean {
    // A YAML document can be a bare scalar, which shows none of the structural
    // signals above — `a,b` is one. Accepting every such document would make
    // YAML a catch-all ahead of CSV, so the plain-scalar case is admitted only
    // when the file name says so.
    return YAML_SHAPE.test(prefix) || namedByFileName;
  }

  async read(input: string): Promise<DocumentNode> {
    let documents: ReturnType<typeof parseAllDocuments>;

    try {
      documents = parseAllDocuments(input, {
        version: '1.2',
        schema: 'core',
        // No custom tags: `!!python/object`, `!Ref` and friends are refused
        // rather than resolved.
        customTags: [],
        prettyErrors: false,
      });
    } catch {
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
    }

    if (documents.length === 0) {
      // An empty stream is an empty document, not an error (§7).
      return null;
    }

    // Only the first document is converted, and a second one is refused:
    // silently dropping it would lose data.
    if (documents.length > 1) {
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
    }

    const [document] = documents;

    if (document.errors.length > 0) {
      // `yaml`'s messages quote the offending source, so only the position
      // survives (FR-023, SC-005).
      const [first] = document.errors;
      const position = first.linePos?.[0];

      throw new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: position?.line,
        column: position?.col,
      });
    }

    // An unsupported tag is a *warning* in `yaml`, not an error: the tag is
    // dropped and the bare value kept. That is exactly the silent coercion the
    // mapping rules refuse — `!Ref something` must not become the string
    // "something" (§6).
    const unresolvedTag = document.warnings.find(
      (warning) => warning.code === 'TAG_RESOLVE_FAILED',
    );

    if (unresolvedTag) {
      // The warning message quotes the source line, so only its position is used.
      const position = unresolvedTag.linePos?.[0];

      throw new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: position?.line,
        column: position?.col,
      });
    }

    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
    } catch {
      // Alias expansion over the cap lands here.
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
    }

    return this.toDocumentNode(value);
  }

  async write(node: DocumentNode): Promise<Buffer> {
    let body: string;

    try {
      body = stringify(node, {
        version: '1.2',
        schema: 'core',
        indent: 2,
        // Block style throughout, and no anchors: output that re-used anchors
        // would re-trigger the alias cap when it was read back. Strings stay
        // unquoted unless quoting is needed to re-parse them unambiguously,
        // which is `yaml`'s own default.
        aliasDuplicateObjects: false,
        lineWidth: 0,
      });
    } catch {
      // A serializer failure is unexpected, but its message would quote the
      // value it choked on — which is the user's data. It is reported as a
      // fixed code like every other failure (FR-023, SC-005).
      throw new ConversionException(ConversionErrorCode.INTERNAL_ERROR);
    }

    return Buffer.from(body, 'utf8');
  }

  /**
   * `toJS` can produce values the model has no room for — a `Date` from a
   * timestamp tag, a `Map` from a non-string key. The core schema admits none
   * of them, so anything left is a refusal rather than a silent coercion.
   */
  private toDocumentNode(value: unknown): DocumentNode {
    if (value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.toDocumentNode(item));
    }

    const type = typeof value;

    if (type === 'string' || type === 'boolean') {
      return value as string | boolean;
    }

    if (type === 'number') {
      // NaN and ±Infinity are core-schema YAML but not representable in JSON,
      // so they would silently become `null` on the way out.
      const numeric = value as number;
      return Number.isFinite(numeric) ? numeric : String(numeric);
    }

    if (
      type === 'object' &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const result: { [key: string]: DocumentNode } = {};
      for (const [key, child] of Object.entries(value as object)) {
        result[key] = this.toDocumentNode(child);
      }
      return result;
    }

    throw new ConversionException(ConversionErrorCode.PARSE_ERROR);
  }
}
