/**
 * Builds the raster fixtures the image-conversion suites read.
 *
 * Committed as a script rather than as binaries so every fixture's *content*
 * is reviewable: "a 16-bit greyscale PNG" is a line of code here instead of an
 * opaque blob whose properties have to be taken on trust. Run it with
 * `npm run fixtures:images`; `pretest:e2e` runs it too, so a fresh checkout
 * needs no extra step.
 *
 * The SVG corpus lives beside the output as hand-written files — those are
 * meant to be read, and generating them would hide exactly the constructs they
 * exist to demonstrate.
 */
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

const OUT_DIR = join(__dirname, 'image-fixtures');

/** A deterministic four-quadrant test card, as raw RGBA. */
function testCard(width: number, height: number, alpha: number): Buffer {
  const data = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const right = x >= width / 2;
      const bottom = y >= height / 2;

      data[offset] = right ? 220 : 40;
      data[offset + 1] = bottom ? 200 : 60;
      data[offset + 2] = right === bottom ? 180 : 80;
      data[offset + 3] = alpha;
    }
  }

  return data;
}

function raw(width: number, height: number, alpha = 255) {
  return sharp(testCard(width, height, alpha), {
    raw: { width, height, channels: 4 },
  });
}

/**
 * Rewrite a PNG's IHDR width and height, fixing up the chunk CRC.
 *
 * IHDR is always the first chunk: 8 signature bytes, a 4-byte length, the type,
 * then width and height as big-endian uint32s.
 */
function declaringSize(png: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(png);
  const length = out.readUInt32BE(8);
  const typeStart = 12;
  const dataStart = typeStart + 4;

  out.writeUInt32BE(width, dataStart);
  out.writeUInt32BE(height, dataStart + 4);
  out.writeUInt32BE(
    crc32(out.subarray(typeStart, dataStart + length)),
    dataStart + length,
  );

  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

async function write(name: string, data: Buffer): Promise<void> {
  await writeFile(join(OUT_DIR, name), data);
  console.log(`  ${name} (${data.length} bytes)`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Generating raster fixtures into ${OUT_DIR}`);

  // The baseline pair. 64x48 is deliberately non-square so a transposed
  // output is visible as a failure rather than as a coincidence.
  await write('solid.png', await raw(64, 48).png().toBuffer());
  await write('solid.jpg', await raw(64, 48).jpeg({ quality: 90 }).toBuffer());

  // Half-transparent throughout, so PNG->JPEG compositing is checkable
  // pixel-by-pixel against the configured background.
  await write('transparent.png', await raw(64, 48, 128).png().toBuffer());

  // Fully transparent: every pixel must come back as exactly the background.
  await write('fully-transparent.png', await raw(32, 32, 0).png().toBuffer());

  // Colour types that a naive decoder refuses instead of normalising.
  await write(
    'greyscale.png',
    await raw(40, 30)
      .removeAlpha()
      .greyscale()
      .toColourspace('b-w')
      .png()
      .toBuffer(),
  );
  await write(
    'indexed.png',
    await raw(40, 30).png({ palette: true, colours: 16 }).toBuffer(),
  );
  await write(
    'sixteen-bit.png',
    await raw(40, 30)
      .png({ compressionLevel: 0 })
      .toColourspace('rgb16')
      .png()
      .toBuffer(),
  );

  // Orientation 6 = rotate 90 CW on display. The stored raster is 48x64 and a
  // viewer shows 64x48, which is the reading FR-008 means by "the source
  // image's pixel dimensions".
  await write(
    'exif-rotated.jpg',
    await raw(48, 64)
      .removeAlpha()
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 90 })
      .toBuffer(),
  );

  // Refusal fixtures.
  const valid = await raw(64, 48).png().toBuffer();
  await write('truncated.png', valid.subarray(0, Math.floor(valid.length / 2)));
  await write('empty.png', Buffer.alloc(0));
  await write('not-an-image.png', Buffer.from('this is plainly not a picture'));

  // A 64x48 PNG's bytes under a name that claims otherwise: content decides.
  await write('jpeg-bytes-named.png', await raw(64, 48).jpeg().toBuffer());

  // Multi-scan input: a progressive JPEG is one picture delivered as several
  // passes, and must decode to one complete image rather than to a first pass.
  //
  // A genuinely *animated* fixture is deliberately absent: libvips cannot write
  // an APNG or a multi-frame GIF on the platforms this runs on, so generating
  // one would mean committing an opaque blob. First-frame-only behaviour rests
  // on sharp's `animated: false` default, which the module README states.
  await write(
    'progressive.jpg',
    await raw(64, 48).removeAlpha().jpeg({ progressive: true }).toBuffer(),
  );

  // The decompression bomb SC-007 tests for: a tiny file whose IHDR *declares*
  // 30000x30000 (900 megapixels). The dimensions are rewritten in place rather
  // than genuinely rendered, because rendering one would need 3.6 GB — which
  // is the whole point. A reader that trusts the header and allocates is the
  // failure being guarded against; a reader that checks the header first
  // refuses it having allocated nothing.
  await write('pixel-bomb.png', declaringSize(valid, 30000, 30000));

  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
