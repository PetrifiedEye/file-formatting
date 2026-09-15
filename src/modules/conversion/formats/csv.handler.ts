import { Injectable } from '@nestjs/common';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';

import {
  ConversionErrorCode,
  FORMAT_EXTENSIONS,
  FORMAT_MEDIA_TYPES,
} from '../conversion.constants';
import { ConversionFormat } from '../conversion.enums';
import { ConversionException } from '../conversion.exception';
import { DocumentNode } from './document-node';
import type { ConversionContext, FormatHandler } from './format-handler';
import { flatten } from './flatten';

/** The column a scalar row is written under, per mapping rule §2.1. */
const SCALAR_COLUMN = 'value';

/** Prefix for values a record carries beyond its header, per §1.6. */
const EXTRA_PREFIX = '_extra_';

/**
 * A cell's text. `null` and an absent path are both the empty field — inherent
 * to CSV, not a choice, and the reason `X → CSV → X` cannot restore a `null`.
 */
function cell(value: DocumentNode | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * CSV, read as `header + records` and written as flattened path columns.
 *
 * **All values stay strings in both directions.** Inferring types would make
 * `CSV → X → CSV` lossy for zip codes (`01234`), version strings (`1.10`), and
 * identifiers past float precision — a silent failure, which is worse than a
 * verbose but exact one. This is what makes SC-001's round trips hold.
 */
@Injectable()
export class CsvHandler implements FormatHandler {
  readonly format = ConversionFormat.CSV;
  readonly mediaType = FORMAT_MEDIA_TYPES[ConversionFormat.CSV];
  readonly extension = FORMAT_EXTENSIONS[ConversionFormat.CSV];
  /** Last in the scan: almost any single line is a legal one-column CSV. */
  readonly detectionPriority = 40;
  readonly sniffIsConclusive = false;

  sniff(prefix: string, namedByFileName: boolean): boolean {
    const firstLine = prefix.split(/\r?\n/, 1)[0];

    if (firstLine.length === 0) {
      return false;
    }

    // A header with no delimiter in it is indistinguishable from a line of
    // prose, and `read` would happily accept either — which would make CSV a
    // catch-all and leave `unsupported_source_format` unreachable. A
    // single-column CSV is therefore recognised only when the file name says
    // `.csv`, which is precisely what the extension hint is for.
    return firstLine.includes(',') || namedByFileName;
  }

  async read(
    input: string,
    { signal }: ConversionContext,
  ): Promise<DocumentNode> {
    const records = await this.parseRecords(input, signal);

    if (records.length === 0) {
      return [];
    }

    const header = this.validateHeader(records[0]);

    // A header with no data records is an empty document, not an error (§1.8).
    return records.slice(1).map((record) => this.toRow(header, record));
  }

  async write(
    node: DocumentNode,
    { limits }: ConversionContext,
  ): Promise<Buffer> {
    const rows = this.selectRows(node).map(flatten);

    // Union of every flattened path, in order of first appearance (§2.3).
    const header: string[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      for (const path of row.keys()) {
        if (!seen.has(path)) {
          seen.add(path);
          header.push(path);
        }
      }
    }

    if (header.length > limits.maxCsvColumns) {
      // Refusing rather than truncating: FR-009 forbids silently dropping data.
      throw new ConversionException(ConversionErrorCode.CSV_TOO_MANY_COLUMNS, {
        limit: limits.maxCsvColumns,
      });
    }

    // Nothing to name and nothing to say: `[]` and `{}` become the empty
    // document, which is the closest CSV has to "valid but carrying nothing".
    if (header.length === 0) {
      return Buffer.alloc(0);
    }

    const records = rows.map((row) =>
      header.map((path) => cell(row.get(path))),
    );

    let body: string;
    try {
      body = stringify(records, {
        header: true,
        columns: header,
        // RFC 4180: CRLF between records, `"` doubled inside a quoted field,
        // and a field quoted exactly when it contains `"`, `,`, CR, or LF.
        record_delimiter: 'windows',
        // `csv-stringify` quotes a field containing the *record delimiter*,
        // which here is CRLF — so a field holding a bare LF or a bare CR would
        // go out unquoted and split the record when read back. Forcing the
        // quote covers both (§2.5).
        quoted_match: /[\r\n]/,
        quoted_empty: false,
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
   * Row selection by the shape of the root (§2.1).
   *
   * An array element that is not an object becomes a `value` row, which makes
   * "array of scalars" and "array of objects" one rule rather than two and gives
   * a mixed array a defined answer instead of an accidental one.
   */
  private selectRows(node: DocumentNode): DocumentNode[] {
    if (Array.isArray(node)) {
      return node.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? item
          : { [SCALAR_COLUMN]: item },
      );
    }

    if (node !== null && typeof node === 'object') {
      return [node];
    }

    return [{ [SCALAR_COLUMN]: node }];
  }

  private validateHeader(record: string[]): string[] {
    const seen = new Set<string>();

    for (const field of record) {
      if (field.length === 0 || seen.has(field)) {
        throw new ConversionException(ConversionErrorCode.CSV_DUPLICATE_HEADER);
      }
      seen.add(field);
    }

    return record;
  }

  /**
   * One data record against the header (§1.3–§1.6).
   *
   * Short records are filled with `""` rather than left missing, so every row
   * has the same shape — which is what lets the result convert cleanly into a
   * structured format.
   */
  private toRow(header: string[], record: string[]): DocumentNode {
    const row: { [key: string]: DocumentNode } = {};

    header.forEach((field, index) => {
      row[field] = record[index] ?? '';
    });

    record.slice(header.length).forEach((surplus, index) => {
      row[`${EXTRA_PREFIX}${index + 1}`] = surplus;
    });

    return row;
  }

  /**
   * Parse incrementally.
   *
   * The `for await` loop is the point: it yields to the event loop between
   * records, so the pipeline's deadline can actually fire during a long parse
   * instead of waiting for a synchronous call to return (FR-019).
   */
  private async parseRecords(
    input: string,
    signal?: AbortSignal,
  ): Promise<string[][]> {
    const parser = parse(input, {
      bom: false,
      columns: false,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    });

    const records: string[][] = [];

    try {
      for await (const record of parser) {
        if (signal?.aborted) {
          parser.destroy();
          break;
        }
        records.push(record as string[]);
      }
    } catch (error) {
      // `csv-parse` messages quote the offending record, so only the position
      // survives (FR-023, SC-005).
      const location = error as { lines?: number; column?: number };
      throw new ConversionException(ConversionErrorCode.PARSE_ERROR, {
        line: typeof location.lines === 'number' ? location.lines : undefined,
      });
    }

    return records;
  }
}
