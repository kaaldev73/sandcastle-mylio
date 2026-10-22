import sharp from "sharp";

/**
 * Image handling for Upload: detect the type from the file's own bytes and
 * generate a thumbnail. This slice supports JPEG and PNG (the PRD's wider set —
 * GIF, WebP, TIFF, HEIC/HEIF, RAW — arrives in later tickets); sharp already
 * decodes far more, so widening support is a matter of extending the table.
 */

/** Longest edge of a generated thumbnail, in pixels. */
const THUMBNAIL_SIZE = 256;

export interface ImageType {
  readonly mime: string;
  /** File extension including the dot, used for the stored original. */
  readonly ext: string;
}

/**
 * Identify a supported image from its leading bytes (a "magic number"), not a
 * client-supplied Content-Type, so a mislabelled or disguised file is judged
 * by what it actually is. Returns null for anything unsupported.
 */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return { mime: "image/png", ext: ".png" };
  }
  return null;
}

export interface Thumbnail {
  readonly data: Buffer;
  readonly mime: string;
}

/**
 * Generate a JPEG thumbnail that fits within THUMBNAIL_SIZE on its longest
 * edge, preserving aspect ratio and honouring EXIF orientation so portrait
 * photos are not shown sideways. The original is never modified (PRD: originals
 * are immutable); this reads it and returns fresh derived bytes.
 */
export async function makeThumbnail(buf: Buffer): Promise<Thumbnail> {
  const data = await sharp(buf)
    .rotate() // apply EXIF orientation, then drop it
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { data, mime: "image/jpeg" };
}
