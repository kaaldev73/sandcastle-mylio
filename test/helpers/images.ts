import sharp from "sharp";

/**
 * Real, small sample images for Upload tests (PRD Testing Decisions: use real
 * sample images as fixtures). They are generated with sharp rather than checked
 * in as binaries so each is a genuine, valid JPEG/PNG with known properties and
 * the suite carries no opaque blobs.
 */

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
