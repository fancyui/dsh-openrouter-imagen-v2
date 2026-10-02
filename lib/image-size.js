/**
 * Pixel dimensions, read out of the bytes.
 *
 * WHY THIS EXISTS
 *
 * The plugin used to report only what it SENT. `render` printed the resolution
 * tier and the aspect ratio out of the outbound request body, so a receipt
 * reading 「参数：2K · 16:9」 was a statement about the request — it came from the
 * same object the request was built from, so it could not possibly disagree
 * with it, and therefore could never tell the caller that the file on disk is
 * not the shape that was asked for.
 *
 * That is not hypothetical. A 2K 16:9 request came back 1536×864 and the
 * receipt still said 2K; the caller had to shell out and read the PNG header to
 * find out what it actually paid for. A receipt that can only echo the request
 * is decoration.
 *
 * DSH's attachment store does report width/height, and those values were
 * already being written into the generation record. They were never shown to the
 * caller, and they disappear when `saveImages` is unavailable or throws — so the
 * plugin was learning a fact about its own bytes from another service. Reading
 * the header costs a few lines and has no such dependency.
 *
 * WHAT IS SUPPORTED, AND WHAT IS NOT
 *
 * PNG (IHDR), JPEG (the SOF frame) and GIF (logical screen descriptor) are read
 * directly. WebP is NOT: it has three container variants with bit-packed 14-bit
 * fields, and a wrong number is worse than no number, so it returns null.
 *
 * Callers must read null as UNKNOWN and never fill it in with a guess. The
 * workbench can still ask DSH for a real dimension, and the agent path pins PNG
 * anyway, so the gap costs nothing today and is stated rather than papered over.
 */

/** PNG's fixed 8-byte file signature (RFC 2083 §3.2.1). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Accept the shapes a caller realistically holds — a Buffer from base64, a
 * plain Uint8Array, an ArrayBuffer, a byte array — without copying when it can
 * be avoided.
 *
 * @returns {Buffer|null} null for anything that is not bytes at all
 */
function asBuffer(input) {
  if (input === null || input === undefined) return null
  if (Buffer.isBuffer(input)) return input
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (Array.isArray(input)) return Buffer.from(input)
  return null
}

/**
 * A parsed dimension pair, or null.
 *
 * Zero is treated as "unreadable" rather than "tiny": no encoder emits a
 * zero-sized image, so a zero here means the bytes were not what the signature
 * claimed, and passing it on would put a 0×0 into a record and a receipt.
 */
function dimension(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

/**
 * PNG: width and height are 4-byte big-endian fields at a fixed offset inside
 * the IHDR chunk, which is always the first chunk. 24 bytes is enough to read
 * them; the rest of the file is image data this function never looks at.
 */
function pngSize(bytes) {
  if (bytes.length < 24) return null
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null
  }
  // bytes 12..15 must spell IHDR, or this is not the chunk we think it is
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null
  return dimension(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
}

/**
 * JPEG: the dimensions live in the SOF segment, whose offset depends on whatever
 * metadata (EXIF, JFIF, colour tables) precedes it. So walk the marker chain
 * from SOI and take the first SOF.
 *
 * Within a segment, `pos` points at its 2-byte length, so the frame header
 * reads: length, sample precision, height, width, component count — which is why
 * width is at +5 and height at +3.
 *
 * The marker set that carries no payload is SOI, TEM and the restart markers;
 * the range D0..D9 covers all of them. SOS means the entropy-coded data starts,
 * so a stream with no SOF before it has nothing left to read.
 */
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let pos = 2
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) {
      pos += 1
      continue
    }
    while (pos < bytes.length && bytes[pos] === 0xff) pos += 1
    if (pos >= bytes.length) return null
    const marker = bytes[pos]
    pos += 1
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue
    if (marker === 0xda) return null
    if (pos + 1 >= bytes.length) return null
    const length = bytes.readUInt16BE(pos)
    if (length < 2) return null
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (pos + 7 > bytes.length) return null
      return dimension(bytes.readUInt16BE(pos + 5), bytes.readUInt16BE(pos + 3))
    }
    pos += length
  }
  return null
}

/** GIF: the logical screen descriptor sits right behind the 6-byte signature. */
function gifSize(bytes) {
  if (bytes.length < 10) return null
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5])
  if (tag !== 'GIF87a' && tag !== 'GIF89a') return null
  return dimension(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
}

/**
 * The pixel size of an encoded image, or null when it cannot be read.
 *
 * Never throws: this runs on bytes that arrived over the network, and a parser
 * that can fail is a parser that can fail the whole generation after the money
 * is already spent.
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|number[]} input encoded image bytes
 * @returns {{width: number, height: number}|null}
 */
export function imageSize(input) {
  const bytes = asBuffer(input)
  if (bytes === null || bytes.length < 4) return null
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes)
}