import { looksLikeJpeg, looksLikePng, looksLikeSvg } from './image-signatures';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0]);
const svg = (text: string) => Buffer.from(text, 'utf8');

describe('image signatures', () => {
  describe('looksLikePng', () => {
    it('accepts the eight-byte signature', () => {
      expect(looksLikePng(PNG)).toBe(true);
    });

    it.each([
      ['a truncated signature', PNG.subarray(0, 7)],
      ['a JPEG', JPEG],
      ['nothing', Buffer.alloc(0)],
    ])('rejects %s', (_label, bytes) => {
      expect(looksLikePng(bytes)).toBe(false);
    });
  });

  describe('looksLikeJpeg', () => {
    it('accepts SOI plus the next marker byte', () => {
      expect(looksLikeJpeg(JPEG)).toBe(true);
    });

    it.each([
      ['SOI alone', JPEG.subarray(0, 2)],
      ['a PNG', PNG],
    ])('rejects %s', (_label, bytes) => {
      expect(looksLikeJpeg(bytes)).toBe(false);
    });
  });

  describe('looksLikeSvg', () => {
    it.each([
      ['a bare root', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      [
        'an XML declaration first',
        '<?xml version="1.0"?>\n<svg width="1"></svg>',
      ],
      ['leading whitespace', '  \n\t<svg>'],
      ['a BOM', '﻿<svg>'],
      ['an upper-case tag', '<SVG>'],
    ])('accepts %s', (_label, text) => {
      expect(looksLikeSvg(svg(text))).toBe(true);
    });

    it.each([
      // A leading `<` alone would claim every XML document feature 010 converts.
      ['XML with no svg element', '<?xml version="1.0"?><root/>'],
      // An `<svg` token alone would claim a text file that mentions one.
      ['text mentioning <svg>', 'see <svg> in the docs'],
      ['a longer tag name', '<svgfoo/>'],
      ['nothing but whitespace', '   '],
    ])('rejects %s', (_label, text) => {
      expect(looksLikeSvg(svg(text))).toBe(false);
    });

    it('does not fail on a prefix cut mid-character', () => {
      // A bounded window can split a UTF-8 sequence; the scan is latin-1.
      const cut = Buffer.concat([svg('<svg><text>'), Buffer.from([0xd0])]);

      expect(looksLikeSvg(cut)).toBe(true);
    });
  });
});
