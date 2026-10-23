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

/** A small solid-colour JPEG with no EXIF metadata. */
export function makeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 60, b: 90 } },
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
