import { ConversionFormat } from '../conversion.enums';
import { DocumentNode } from './document-node';

/**
 * Every limit the pipeline applies, resolved once from configuration and handed
 * to the handlers. Handlers never read `ConfigService` themselves: that keeps
 * them unit-testable against arbitrary limits and stops one from inventing its
 * own ceiling.
 */
export interface ConversionLimits {
  /** Per **source** format — the applicable limit is the detected one (FR-016). */
  maxInputBytes: Record<ConversionFormat, number>;
  maxOutputBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxCsvColumns: number;
  timeoutMs: number;
  /** Conversions that may hold a parsed document at once. Bounds memory. */
  maxConcurrent: number;
}

/**
 * What a handler is given besides the document itself.
 *
 * One object rather than trailing positional arguments, so a handler can take
 * only what it needs — the CSV reader wants the abort signal and not the
 * limits, the CSV writer the reverse — and so a later addition does not change
 * every signature.
 */
export interface ConversionContext {
  limits: ConversionLimits;
  /** Expires with the conversion deadline; honoured by incremental parsers. */
  signal?: AbortSignal;
}

/**
 * One format, read into the canonical model and written back out. Conversion is
 * always `read(source) → DocumentNode → write(target)`, so N handlers give
 * N×(N−1) directions — four handlers are the twelve the spec requires.
 *
 * Adding a format is one new implementation of this interface plus one provider
 * entry. Nothing here is pairwise, so no existing handler, the controller, the
 * DTOs, and the discovery endpoint all stay untouched (FR-029, FR-030).
 */
export interface FormatHandler {
  readonly format: ConversionFormat;
  readonly mediaType: string;
  readonly extension: string;

  /**
   * Where this format sits in the detection scan — lower runs first. Declared by
   * the handler rather than hard-coded in the detector, so a new format slots
   * itself into the order without the detector learning about it.
   */
  readonly detectionPriority: number;

  /**
   * Whether a passing {@link sniff} settles the question on its own.
   *
   * Only XML sets this: a leading `<` cannot begin any other supported format,
   * so malformed XML must be reported as malformed rather than falling through
   * the scan and coming back as "unsupported". Every other format has to prove
   * itself by parsing, which is what keeps "unsupported" and "malformed"
   * distinguishable.
   */
  readonly sniffIsConclusive: boolean;

  /**
   * A cheap structural check against the decoded, BOM-stripped prefix. Never a
   * full parse — the prefix may stop mid-document.
   *
   * `namedByFileName` says the upload's extension named *this* format. It may
   * only ever **widen** what a handler is willing to consider, never narrow it:
   * the scan order is unchanged, so content still decides and the extension
   * stays the secondary hint FR-003 calls for. It is what lets `a,b` — a legal
   * YAML scalar and a legal one-column CSV header both — come out as whichever
   * the file name says.
   */
  sniff(prefix: string, namedByFileName: boolean): boolean;

  /**
   * Parse into the canonical model, or throw a `ConversionException` carrying a
   * fixed code. Library parser messages quote the input and must not escape
   * this call (FR-023).
   *
   * Input arrives already validated as UTF-8 and with any BOM consumed, so the
   * encoding rules are applied once at the boundary instead of four times here.
   */
  read(input: string, context: ConversionContext): Promise<DocumentNode>;

  /**
   * Serialize the model **completely**. The pipeline sends the returned buffer
   * only after it exists in full, which is what makes a partial file
   * unrepresentable (FR-008).
   */
  write(node: DocumentNode, context: ConversionContext): Promise<Buffer>;
}

/** Multi-provider token: every registered `FormatHandler`. */
export const FORMAT_HANDLERS = Symbol('FORMAT_HANDLERS');

/** The resolved {@link ConversionLimits} for this process. */
export const CONVERSION_LIMITS = Symbol('CONVERSION_LIMITS');
