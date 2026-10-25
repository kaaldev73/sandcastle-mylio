/**
 * Minimal EXIF reader for JPEG and TIFF-based camera files. The PRD reads the
 * capture date and location from the file where present; this extracts those
 * without an image library so the dependency stays off the metadata path. It
 * walks a JPEG's APP1 Exif segment (or accepts a TIFF header directly, as
 * TIFF-based camera RAW formats are their own TIFF block), parses just enough
 * of the TIFF structure for what is needed, and ignores everything else.
 * Anything malformed or missing yields null, letting the caller fall back.
 */

// EXIF tag numbers we care about.
const TAG_DATETIME = 0x0132; // IFD0: file change date/time
const TAG_EXIF_IFD = 0x8769; // IFD0: pointer to the Exif sub-IFD
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD: when the photo was taken
const TAG_DATETIME_DIGITIZED = 0x9004; // Exif IFD: when it was digitised
const TAG_GPS_IFD = 0x8825; // IFD0: pointer to the GPS sub-IFD

// GPS sub-IFD tag numbers.
const GPS_LATITUDE_REF = 0x0001; // hemisphere letter ("N"/"S")
const GPS_LATITUDE = 0x0002; // degrees/minutes/seconds
const GPS_LONGITUDE_REF = 0x0003; // hemisphere letter ("E"/"W")
const GPS_LONGITUDE = 0x0004; // degrees/minutes/seconds

/** Field widths in bytes by EXIF type (bounds include the ones we read). */
const TYPE_BYTES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface TagEntry {
  /** EXIF field type of the variable holding the value. */
  type: number;
  count: number;
  /** Where the values sit in the underlying buffer. */
  off: number;
}

/**
 * An endianness-aware view over one located TIFF block. `tiff` is the offset
 * of the TIFF header inside the buffer — 0 for a TIFF file, deeper inside a
 * JPEG's APP1 segment.
 */
interface Tiff {
  buf: Buffer;
  tiff: number;
  little: boolean;
  u16(o: number): number;
  u32(o: number): number;
}

function tiffOver(buf: Buffer, tiff: number): Tiff {
  const little = buf.toString("latin1", tiff, tiff + 2) === "II";
  const u16 = (o: number) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  return { buf, tiff, little, u16, u32 };
}

/** Signed EXIF types wrap into their negative values as stored. */
function asSigned(type: number, value: number): number {
  if (type === 9) return value | 0; // SLONG
  if (type === 10) return value >= 0x80000000 ? value - 0x100000000 : value; // SRATIONAL
  return value;
}

/**
 * Read one IFD's tags into a tag→entry map, resolving each value's in-buffer
 * position: values up to 4 bytes sit inline in the entry itself, larger ones
 * sit at an offset relative to the start of the TIFF block. Truncated
 * structures simply yield the tags read so far.
 */
function readIfd(tiff: Tiff, ifdOffset: number): Map<number, TagEntry> {
  const base = tiff.tiff + ifdOffset;
  const tags = new Map<number, TagEntry>();
  if (base + 2 > tiff.buf.length) return tags;
  const entries = tiff.u16(base);
  for (let i = 0; i < entries; i++) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > tiff.buf.length) break;
    const type = tiff.u16(entry + 2);
    const count = tiff.u32(entry + 4);
    // A malformed type falls back to 1-byte values; a huge count is capped
    // by the bounds checks further down.
    const bytes = (TYPE_BYTES[type] ?? 1) * count;
    const off = bytes <= 4 ? entry + 8 : tiff.tiff + tiff.u32(entry + 8);
    tags.set(tiff.u16(entry), { type, count, off });
  }
  return tags;
}

function fits(tiff: Tiff, off: number, length: number): boolean {
  return off >= 0 && off + length <= tiff.buf.length;
}

/** A tag's ASCII value, NUL-terminated, or "" when unreadable. */
function tagString(tiff: Tiff, entry: TagEntry | undefined): string {
  if (!entry) return "";
  const length = (TYPE_BYTES[entry.type] ?? 1) * entry.count;
  if (!fits(tiff, entry.off, length)) return "";
  return tiff.buf
    .toString("latin1", entry.off, entry.off + length)
    .replace(/\0.*$/, "")
    .trim();
}

/** A tag's scalar values in entry order (signed types unwrapped), truncated
 * at the first entry the buffer does not fully contain. */
function tagInts(tiff: Tiff, entry: TagEntry): number[] {
  const bytes = TYPE_BYTES[entry.type] ?? 1;
  const values: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const at = entry.off + i * bytes;
    let value: number | null = null;
    if (bytes === 1 && fits(tiff, at, 1)) {
      value = tiff.buf[at];
    } else if (bytes === 2 && fits(tiff, at, 2)) {
      value = tiff.little ? tiff.buf.readUInt16LE(at) : tiff.buf.readUInt16BE(at);
    } else if (bytes === 4 && fits(tiff, at, 4)) {
      value = tiff.little ? tiff.buf.readUInt32LE(at) : tiff.buf.readUInt32BE(at);
    }
    if (value === null) break;
    values.push(asSigned(entry.type, value));
  }
  return values;
}

/** A tag's values as numbers; each RATIONAL pair becomes its quotient
 * (NaN when the denominator is 0). */
function tagValues(tiff: Tiff, entry: TagEntry): number[] {
  const bytes = TYPE_BYTES[entry.type] ?? 1;
  if (bytes !== 8) return tagInts(tiff, entry);
  const values: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const pair = entry.off + i * 8;
    if (!fits(tiff, pair, 8)) break;
    const num = tiff.little ? tiff.buf.readUInt32LE(pair) : tiff.buf.readUInt32BE(pair);
    const den = tiff.little ? tiff.buf.readUInt32LE(pair + 4) : tiff.buf.readUInt32BE(pair + 4);
    const numerator = asSigned(entry.type, num);
    const denominator = asSigned(entry.type, den);
    values.push(denominator === 0 ? NaN : numerator / denominator);
  }
  return values;
}

/**
 * Find the TIFF block: a JPEG's APP1 "Exif\0\0" payload, or — for TIFF-based
 * camera files (the common RAW containers) — the buffer's own TIFF header.
 * Returns null when the buffer carries neither or the header is truncated.
 */
function locateTiff(buf: Buffer): Tiff | null {
  let offset = -1;
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: scan marker segments for APP1 carrying an "Exif\0\0" payload.
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
        offset = segStart + 6;
        break;
      }
      off = segEnd;
    }
  } else {
    // TIFF-based file: the TIFF header is its start ("II*", "MM*").
    const order = buf.toString("latin1", 0, 2);
    if (order === "II" || order === "MM") offset = 0;
  }
  // The header must be complete: if its IFD0 pointer is not fully present,
  // no tag value can be trustworthy.
  if (offset < 0 || offset + 8 > buf.length) return null;
  try {
    return tiffOver(buf, offset);
  } catch {
    return null; // any out-of-range read means the metadata is not trustworthy
  }
}

/**
 * Read the capture date from EXIF metadata, as epoch milliseconds, or null if
 * the file carries none. EXIF timestamps have no timezone, so the
 * "YYYY:MM:DD HH:MM:SS" value is interpreted as UTC for a stable, deterministic
 * result.
 */
export function readCaptureDate(buf: Buffer): number | null {
  const tiff = locateTiff(buf);
  if (!tiff) return null;

  const raw = readExifDateString(tiff);
  return raw === null ? null : parseExifDate(raw);
}

/** Find the most specific EXIF date string in a TIFF block, or null. */
function readExifDateString(tiff: Tiff): string | null {
  const ifd0 = readIfd(tiff, tiff.u32(tiff.tiff + 4));

  const exifPtr = ifd0.get(TAG_EXIF_IFD);
  if (exifPtr) {
    const exifIfd = readIfd(tiff, tiff.u32(exifPtr.off));
    const original =
      exifIfd.get(TAG_DATETIME_ORIGINAL) ?? exifIfd.get(TAG_DATETIME_DIGITIZED);
    if (original) {
      const value = tagString(tiff, original);
      if (value) return value;
    }
  }
  const dateTime = ifd0.get(TAG_DATETIME);
  if (dateTime) {
    const value = tagString(tiff, dateTime);
    if (value) return value;
  }
  return null;
}

/** Hemisphere letters: north/east are positive, south/west negative. */
function hemiSign(ref: string): number | null {
  const letter = ref.trim().toUpperCase()[0];
  if (letter === "N" || letter === "E") return 1;
  if (letter === "S" || letter === "W") return -1;
  return null;
}

/** Keep a sensible number of decimal places for map-level coordinates. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Read where a photo was taken from its EXIF GPS tags, as decimal degrees, or
 * null when the file carries none. Degree/minute/second rationals become a
 * decimal position; the hemisphere reference supplies the sign. A missing
 * reference or magnitude means the file's GPS data is incomplete and is
 * treated as absent rather than guessed.
 */
export function readGpsLocation(
  buf: Buffer,
): { latitude: number; longitude: number } | null {
  const tiff = locateTiff(buf);
  if (!tiff) return null;

  const ifd0 = readIfd(tiff, tiff.u32(tiff.tiff + 4));
  const gpsPtr = ifd0.get(TAG_GPS_IFD);
  if (!gpsPtr) return null;

  const gps = readIfd(tiff, tiff.u32(gpsPtr.off));

  const decimal = (entry: TagEntry | undefined): number | null => {
    if (!entry) return null;
    const values = tagValues(tiff, entry);
    if (values.length < 3 || values.some((v) => !Number.isFinite(v) || v < 0)) {
      return null;
    }
    return values[0] + values[1] / 60 + values[2] / 3600;
  };

  const signOf = (refEntry: TagEntry | undefined): number | null => {
    const ref = tagString(tiff, refEntry);
    return ref === "" ? null : hemiSign(ref);
  };

  const latitude = decimal(gps.get(GPS_LATITUDE));
  const latitudeSign = signOf(gps.get(GPS_LATITUDE_REF));
  const longitude = decimal(gps.get(GPS_LONGITUDE));
  const longitudeSign = signOf(gps.get(GPS_LONGITUDE_REF));
  if (
    latitude === null ||
    longitude === null ||
    latitudeSign === null ||
    longitudeSign === null
  ) {
    return null;
  }

  return {
    latitude: round6(latitude * latitudeSign),
    longitude: round6(longitude * longitudeSign),
  };
}

/** Convert an EXIF "YYYY:MM:DD HH:MM:SS" string to epoch ms (UTC), or null. */
function parseExifDate(value: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m.map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isNaN(ms) ? null : ms;
}
