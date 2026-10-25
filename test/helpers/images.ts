import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

/**
 * Real, small sample images for Upload tests (PRD Testing Decisions: use real
 * sample images as fixtures). Most are generated with sharp so each is a
 * genuine, valid image with known properties and the suite carries no opaque
 * blobs. HEIC/HEIF and camera RAW cannot be encoded by sharp's prebuilt
 * libvips, so those are small real samples checked in under test/fixtures.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

/** A small solid-colour JPEG with no EXIF metadata. Pass a width override to
 * make images with different bytes (e.g. when a test uploads several photos
 * that must each be a distinct Asset; a colour tweak alone can quantize to
 * the same JPEG bytes). */
export function makeJpeg(
  width = 120,
  background = { r: 200, g: 60, b: 90 },
): Promise<Buffer> {
  return sharp({
    create: { width, height: 80, channels: 3, background },
  })
    .jpeg()
    .toBuffer();
}

/**
 * A small JPEG carrying an EXIF DateTimeOriginal. `date` is an EXIF-format
 * "YYYY:MM:DD HH:MM:SS" string; sharp writes it into the Exif sub-IFD (IFD2).
 */
export function makeJpegWithCaptureDate(date: string): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 40, g: 90, b: 180 } },
  })
    .jpeg()
    .withExif({ IFD2: { DateTimeOriginal: date } })
    .toBuffer();
}

/**
 * Split a decimal-degree value into the GPS degrees/minutes/seconds rationals
 * (seconds recorded to 1/100 s), returning their magnitude; the sign travels
 * in the hemisphere reference letter instead.
 */
function degreeRationals(value: number): [number, number][] {
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60 * 100) / 100;
  return [
    [degrees, 1],
    [minutes, 1],
    [seconds * 100, 100],
  ];
}

/**
 * Build a minimal EXIF TIFF block (little endian) whose IFD0 points at a GPS
 * sub-IFD carrying a latitude/longitude. Written by hand rather than by
 * sharp: libvips drops GPS/IFD3 keys when re-encoding EXIF. The layout is
 * header → IFD0 (GPS pointer, one entry) → GPS IFD (ref/value entries) → the
 * out-of-line RATIONAL values.
 */
function buildGpsExifTiff(latitude: number, longitude: number): Buffer {
  const tiff = Buffer.alloc(140);
  tiff.write("II", 0, "latin1");
  tiff.writeUint16LE(42, 2);
  tiff.writeUint32LE(8, 4); // IFD0 follows the header

  // IFD0 at 8: one entry, pointing at the GPS sub-IFD.
  tiff.writeUint16LE(1, 8);
  tiff.writeUint16LE(0x8825, 10); // GPSInfo tag
  tiff.writeUint16LE(4, 12); // LONG
  tiff.writeUint32LE(1, 14);
  tiff.writeUint32LE(26, 18); // GPS IFD offset
  tiff.writeUint32LE(0, 22); // no next IFD

  // GPS IFD at 26: reference and value entries for both coordinates.
  tiff.writeUint16LE(4, 26);
  tiff.writeUint32LE(0, 76); // no next IFD
  const gpsEntry = (
    i: number,
    tag: number,
    type: number,
    count: number,
    inline?: Buffer,
    offset?: number,
  ): void => {
    const entry = 28 + i * 12;
    tiff.writeUint16LE(tag, entry);
    tiff.writeUint16LE(type, entry + 2);
    tiff.writeUint32LE(count, entry + 4);
    if (inline !== undefined) {
      inline.copy(tiff, entry + 8); // left-justified in the 4-byte field
    } else {
      tiff.writeUint32LE(offset ?? 0, entry + 8);
    }
  };
  const latRef = latitude >= 0 ? "N" : "S";
  const lonRef = longitude >= 0 ? "E" : "W";

  gpsEntry(0, 0x0001, 2, 2, Buffer.from(`${latRef}\0`, "latin1"));
  gpsEntry(1, 0x0002, 5, 3, undefined, 80);
  gpsEntry(2, 0x0003, 2, 2, Buffer.from(`${lonRef}\0`, "latin1"));
  gpsEntry(3, 0x0004, 5, 3, undefined, 104);

  // The out-of-line RATIONAL triples: first latitude at 80, longitude at 104.
  const writeRationals = (offset: number, value: number): void => {
    const parts = degreeRationals(value);
    parts.forEach(([num, den], i) => {
      tiff.writeUint32LE(num, offset + i * 8);
      tiff.writeUint32LE(den, offset + i * 8 + 4);
    });
  };
  writeRationals(80, latitude);
  writeRationals(104, longitude);
  return tiff;
}

/**
 * Insert a marker segment (e.g. a hand-built EXIF APP1) after a JPEG's SOI,
 * splicing its own APP1s behind it. JPEG tolerates several APP1 segments;
 * mainstream writers put EXIF first.
 */
function spliceJpegSegment(jpeg: Buffer, segment: Buffer): Buffer {
  const before = jpeg.subarray(0, 2); // SOI
  const after = jpeg.subarray(2);
  const header = Buffer.alloc(4);
  header.writeUint8(0xff, 0);
  header.writeUint8(0xe1, 1); // APP1
  header.writeUint16BE(segment.length + 2, 2);
  return Buffer.concat([before, header, segment, after]);
}

/**
 * A small JPEG carrying EXIF GPS coordinates, as a camera or phone would
 * produce for a geotagged photo. `latitude`/`longitude` are decimal degrees;
 * negative values become S/W. sharp cannot produce this (see above), so the
 * JPEG is generated first and a self-built APP1 EXIF segment with GPS IFD is
 * spliced in.
 */
export function makeJpegWithGps(latitude: number, longitude: number): Promise<Buffer> {
  return sharp({
    create: { width: 100, height: 70, channels: 3, background: { r: 150, g: 100, b: 60 } },
  })
    .jpeg()
    .toBuffer()
    .then((jpeg) =>
      spliceJpegSegment(
        jpeg,
        Buffer.concat([Buffer.from("Exif\0\0", "latin1"), buildGpsExifTiff(latitude, longitude)]),
      ),
    );
}

/** A small solid-colour PNG. */
export function makePng(): Promise<Buffer> {
  return sharp({
    create: { width: 90, height: 140, channels: 4, background: { r: 20, g: 160, b: 80, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

/** A small solid-colour WebP. */
export function makeWebp(): Promise<Buffer> {
  return sharp({
    create: { width: 110, height: 70, channels: 3, background: { r: 90, g: 40, b: 200 } },
  })
    .webp()
    .toBuffer();
}

/** A small solid-colour GIF. */
export function makeGif(): Promise<Buffer> {
  return sharp({
    create: { width: 70, height: 110, channels: 3, background: { r: 220, g: 180, b: 20 } },
  })
    .gif()
    .toBuffer();
}

/** A small solid-colour TIFF. */
export function makeTiff(): Promise<Buffer> {
  return sharp({
    create: { width: 130, height: 90, channels: 3, background: { r: 10, g: 120, b: 130 } },
  })
    .tiff()
    .toBuffer();
}

/** A real HEIC sample (HEVC-encoded by libheif), generated once with ImageMagick. */
export function makeHeic(): Buffer {
  return fixture("sample.heic");
}

/** A real HEIF sample: the same HEVC image with generic `mif1` brands. */
export function makeHeif(): Buffer {
  return fixture("sample.heif");
}

/** A real camera RAW sample (Kodak DC50 KDC, a TIFF-based RAW format). */
export function makeRaw(): Buffer {
  return fixture("sample.kdc");
}
