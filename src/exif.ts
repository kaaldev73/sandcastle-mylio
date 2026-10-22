/**
 * Minimal EXIF capture-date reader for JPEG. The PRD reads the capture date
 * from the file where present and falls back to the file date; this extracts
 * that date without an image library so the dependency stays off the metadata
 * path. It walks the JPEG's APP1 Exif segment, parses just enough of the TIFF
 * structure to find DateTimeOriginal (or DateTime), and ignores everything
 * else. Anything malformed or missing yields null, letting the caller fall
 * back to the file date.
 */

// EXIF tag numbers we care about.
const TAG_DATETIME = 0x0132; // IFD0: file change date/time
const TAG_EXIF_IFD = 0x8769; // IFD0: pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD: when the photo was taken
const TAG_DATETIME_DIGITIZED = 0x9004; // Exif IFD: when it was digitised

/**
 * Read the capture date from a JPEG's EXIF metadata, as epoch milliseconds, or
 * null if the file carries none. EXIF timestamps have no timezone, so the
 * "YYYY:MM:DD HH:MM:SS" value is interpreted as UTC for a stable, deterministic
 * result.
 */
export function readCaptureDate(buf: Buffer): number | null {
  const raw = readExifDateString(buf);
  return raw === null ? null : parseExifDate(raw);
}

/** Find the most specific EXIF date string in a JPEG, or null. */
function readExifDateString(buf: Buffer): string | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not JPEG

  // Scan marker segments for APP1 carrying an "Exif\0\0" payload.
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan
    const segLen = buf.readUInt16BE(off + 2);
    if (segLen < 2) return null;
    const segStart = off + 4;
    const segEnd = off + 2 + segLen;
    if (segEnd > buf.length) return null;

    if (marker === 0xe1 && buf.toString("latin1", segStart, segStart + 6) === "Exif\0\0") {
      return readTiffDate(buf, segStart + 6);
    }
    off = segEnd;
  }
  return null;
}

/** Parse the TIFF block at `tiff` and return a date string, or null. */
function readTiffDate(buf: Buffer, tiff: number): string | null {
  try {
    const byteOrder = buf.toString("latin1", tiff, tiff + 2);
    const little = byteOrder === "II";
    if (!little && byteOrder !== "MM") return null;

    const u16 = (o: number) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
    const u32 = (o: number) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

    /** Read an IFD into a tag→{count, valueOffset} map. */
    const readIfd = (ifdOff: number): Map<number, { count: number; valueOffset: number }> => {
      const tags = new Map<number, { count: number; valueOffset: number }>();
      if (ifdOff + 2 > buf.length) return tags;
      const entries = u16(ifdOff);
      for (let i = 0; i < entries; i++) {
        const entry = ifdOff + 2 + i * 12;
        if (entry + 12 > buf.length) break;
        tags.set(u16(entry), { count: u32(entry + 4), valueOffset: entry + 8 });
      }
      return tags;
    };

    /** Read an ASCII tag value, resolving the out-of-line offset when needed. */
    const asString = (tag: { count: number; valueOffset: number }): string => {
      // Values up to 4 bytes sit inline; larger ones are stored at an offset
      // relative to the start of the TIFF block.
      const dataOff = tag.count <= 4 ? tag.valueOffset : tiff + u32(tag.valueOffset);
      if (dataOff + tag.count > buf.length) return "";
      return buf.toString("latin1", dataOff, dataOff + tag.count).replace(/\0+$/, "");
    };

    const ifd0 = readIfd(tiff + u32(tiff + 4));

    const exifPtr = ifd0.get(TAG_EXIF_IFD);
    if (exifPtr) {
      const exifIfd = readIfd(tiff + u32(exifPtr.valueOffset));
      const original = exifIfd.get(TAG_DATETIME_ORIGINAL) ?? exifIfd.get(TAG_DATETIME_DIGITIZED);
      if (original) {
        const s = asString(original);
        if (s) return s;
      }
    }
    const dateTime = ifd0.get(TAG_DATETIME);
    if (dateTime) {
      const s = asString(dateTime);
      if (s) return s;
    }
    return null;
  } catch {
    return null; // any out-of-range read means the metadata is not trustworthy
  }
}

/** Convert an EXIF "YYYY:MM:DD HH:MM:SS" string to epoch ms (UTC), or null. */
function parseExifDate(value: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m.map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isNaN(ms) ? null : ms;
}
