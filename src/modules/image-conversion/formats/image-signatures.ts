import {
  JPEG_SIGNATURE,
  PNG_SIGNATURE,
  UTF8_BOM,
} from '../image-conversion.constants';

/**
 * The byte-level signature test for each format, as three pure predicates.
 *
 * They live beside the handlers rather than inside them so the detector can be
 * tested against the *real* signature rules without constructing a decoder —
 * each handler's `sniff` is a one-line delegation to the matching function
 * here, so there is one definition of "this is a PNG", not two.
 */

/** `89 50 4E 47 0D 0A 1A 0A`. */
export function looksLikePng(prefix: Buffer): boolean {
  return prefix.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** `FF D8 FF` — the SOI marker plus the first byte of the next one. */
export function looksLikeJpeg(prefix: Buffer): boolean {
  return prefix.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE);
}

/**
 * An optional BOM and leading whitespace, then `<`, with an `<svg` token
 * somewhere in the bounded prefix.
 *
 * Both halves are required: a leading `<` alone would claim every XML document
 * — including the ones feature 010 converts — while an `<svg` token alone
 * would claim a text file that merely mentions one.
 *
 * The prefix is decoded as latin-1 rather than UTF-8 on purpose: this is a
 * bounded window that may stop mid-character, and a signature scan must not
 * fail on a split multi-byte sequence. Real UTF-8 validation happens later,
 * against the whole upload.
 */
export function looksLikeSvg(prefix: Buffer): boolean {
  const body = prefix.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)
    ? prefix.subarray(UTF8_BOM.length)
    : prefix;

  const text = body.toString('latin1');
  const start = text.search(/\S/);

  if (start === -1 || text[start] !== '<') {
    return false;
  }

  return /<svg[\s/>]/i.test(text);
}
