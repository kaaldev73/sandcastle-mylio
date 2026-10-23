import sharp from "sharp";

/**
 * Image handling for Upload: detect the type from the file's own bytes and
 * generate a browser-friendly preview. Supports JPEG, PNG, GIF, WebP, TIFF,
 * HEIC/HEIF and common camera RAW formats. RAW files are often TIFF or ISO
 * BMFF containers that sharp cannot decode directly, but they carry an
 * embedded JPEG preview; HEIC/HEIF needs a WASM HEVC decoder. makeThumbnail
 * falls back to those when sharp cannot decode the file itself.
 */

/** Longest edge of a generated thumbnail, in pixels. */
const THUMBNAIL_SIZE = 256;

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export interface ImageType {
  readonly mime: string;
  /** File extension including the dot, used for the stored original. */
  readonly ext: string;
}

/** Does the buffer start with `magic` at `offset` (default 0)? */
function hasMagic(buf: Buffer, magic: readonly number[], offset = 0): boolean {
  if (buf.length < offset + magic.length) return false;
  return magic.every((byte, i) => buf[offset + i] === byte);
}

/** Does the buffer start with the ASCII text `text` at `offset` (default 0)? */
function hasText(buf: Buffer, text: string, offset = 0): boolean {
  if (buf.length < offset + text.length) return false;
  return buf.toString("latin1", offset, offset + text.length) === text;
}

/**
 * Identify the HEIF/HEIC/CR3 brand in an ISO BMFF `ftyp` box. Returns null when
 * the buffer is not an ISO BMFF file this app accepts.
 */
function detectIsoBmff(buf: Buffer): ImageType | null {
  if (!hasText(buf, "ftyp", 4) || buf.length < 12) return null;

  const boxSize = buf.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : buf.length, buf.length);
  const brands: string[] = [buf.toString("latin1", 8, 12).trim().toLowerCase()];
  for (let off = 16; off + 4 <= end; off += 4) {
    brands.push(buf.toString("latin1", off, off + 4).trim().toLowerCase());
  }

  if (brands.includes("crx")) {
    return { mime: "image/x-canon-cr3", ext: ".cr3" };
  }
  const heicBrands = [
    "heic",
    "heix",
    "hevc",
    "hevx",
    "heim",
    "heis",
    "hevm",
    "hevs",
  ];
  if (brands.some((brand) => heicBrands.includes(brand))) {
    return { mime: "image/heic", ext: ".heic" };
  }
  if (brands.some((brand) => ["heif", "mif1", "msf1"].includes(brand))) {
    return { mime: "image/heif", ext: ".heif" };
  }
  return null;
}

/**
 * Identify a supported image from its leading bytes (a "magic number"), not a
 * client-supplied Content-Type, so a mislabelled or disguised file is judged
 * by what it actually is. Returns null for anything unsupported.
 */
export function detectImageType(buf: Buffer): ImageType | null {
  if (hasMagic(buf, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", ext: ".jpg" };
  }
  if (hasMagic(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", ext: ".png" };
  }
  if (hasText(buf, "GIF87a") || hasText(buf, "GIF89a")) {
    return { mime: "image/gif", ext: ".gif" };
  }
  if (hasText(buf, "RIFF") && hasText(buf, "WEBP", 8)) {
    return { mime: "image/webp", ext: ".webp" };
  }

  // TIFF and most camera RAW formats (CR2, NEF, ARW, DNG, PEF, SRW, KDC, ...)
  // share the TIFF byte-order magic. A CR2 is marked by "CR" at offset 8.
  if (hasMagic(buf, [0x49, 0x49, 0x2a, 0x00]) || hasMagic(buf, [0x4d, 0x4d, 0x00, 0x2a])) {
    if (hasText(buf, "CR", 8)) {
      return { mime: "image/x-canon-cr2", ext: ".cr2" };
    }
    return { mime: "image/tiff", ext: ".tiff" };
  }
  // Olympus ORF and Panasonic RW2 are TIFF variants with their own headers.
  if (hasText(buf, "IIRO") || hasText(buf, "MMOR")) {
    return { mime: "image/x-olympus-orf", ext: ".orf" };
  }
  if (hasMagic(buf, [0x49, 0x49, 0x55, 0x00])) {
    return { mime: "image/x-panasonic-rw2", ext: ".rw2" };
  }

  if (hasText(buf, "FUJIFILMCCD-RAW ")) {
    return { mime: "image/x-fuji-raf", ext: ".raf" };
  }
  if (hasText(buf, "FOVb")) {
    return { mime: "image/x-sigma-x3f", ext: ".x3f" };
  }

  return detectIsoBmff(buf);
}

export interface Thumbnail {
  readonly data: Buffer;
  readonly mime: string;
}

type SharpOptions = NonNullable<Parameters<typeof sharp>[1]>;

/** Decode one candidate buffer into a JPEG thumbnail. */
async function thumbnailFrom(
  buf: Buffer,
  options: SharpOptions = { failOn: "none" },
): Promise<Thumbnail> {
  const data = await sharp(buf, options)
    .rotate() // apply EXIF orientation, then drop it
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  return { data, mime: "image/jpeg" };
}

/**
 * Decode a HEIC/HEIF image with libheif compiled to WebAssembly. sharp's
 * prebuilt libvips omits the HEVC decoder for licensing reasons, so without
 * this fallback a perfectly valid HEIC could not be previewed. The decoder is
 * imported lazily, keeping its sizeable wasm payload out of the common path.
 */
async function heicThumbnail(buf: Buffer): Promise<Thumbnail> {
  const { default: decode } = await import("heic-decode");
  const image = await decode({ buffer: buf });
  const pixels = Buffer.from(
    image.data.buffer,
    image.data.byteOffset,
    image.data.byteLength,
  );
  return thumbnailFrom(pixels, {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
}

/**
 * Find JPEG streams embedded in a container (camera RAW files commonly hold a
 * full-size JPEG preview). Returned largest first, since that is the best
 * preview. Scanning is deliberately simple: previews are standalone streams,
 * not nested inside another JPEG's metadata.
 */
function embeddedJpegs(buf: Buffer): Buffer[] {
  const found: Buffer[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const start = buf.indexOf(JPEG_SOI, offset);
    if (start === -1) break;
    const end = buf.indexOf(JPEG_EOI, start + JPEG_SOI.length);
    if (end === -1) {
      offset = start + 1;
      continue;
    }
    found.push(buf.subarray(start, end + JPEG_EOI.length));
    offset = end + JPEG_EOI.length;
  }
  return found.sort((a, b) => b.length - a.length);
}

/**
 * Generate a JPEG thumbnail that fits within THUMBNAIL_SIZE on its longest
 * edge, preserving aspect ratio and honouring EXIF orientation so portrait
 * photos are not shown sideways. Camera RAW formats that sharp cannot decode
 * directly fall back to their embedded JPEG preview; HEIC/HEIF falls back to a
 * WASM HEVC decoder. The original is never modified (PRD: originals are
 * immutable); this reads it and returns fresh derived bytes.
 */
export async function makeThumbnail(buf: Buffer): Promise<Thumbnail> {
  try {
    return await thumbnailFrom(buf);
  } catch {
    // Not directly decodable by libvips; try the containers' previews below.
  }

  for (const candidate of embeddedJpegs(buf)) {
    try {
      return await thumbnailFrom(candidate);
    } catch {
      // Try the next embedded preview; maybe it is the valid one.
    }
  }

  try {
    return await heicThumbnail(buf);
  } catch {
    // Not HEIC/HEIF (or it is corrupt); report undecodable to the caller.
  }

  throw new Error("no decodable image data");
}
