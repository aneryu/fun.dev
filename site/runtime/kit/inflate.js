// Raw DEFLATE (RFC 1951) decoding for hosts without DecompressionStream, such as fun's
// application profile (docs/hosts.md). The caller states the exact output length, so the
// output is allocated once and never grows: more data than declared is refused, as is any
// malformed stream. Written after zlib's puff.c; bit by bit, which is fast enough for the
// chunk sizes .fun3d files carry (geometry and the manifest; images are stored as encoded).

const MAX_BITS = 15;
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export class InflateError extends Error {}

/** A canonical Huffman code from a list of code lengths (0 = unused symbol). */
function buildCode(lengths) {
  const count = new Uint16Array(MAX_BITS + 1);
  for (const length of lengths) count[length]++;
  count[0] = 0;
  let left = 1;
  for (let length = 1; length <= MAX_BITS; length++) {
    left = (left << 1) - count[length];
    if (left < 0) throw new InflateError("Over-subscribed Huffman code");
  }
  const offsets = new Uint16Array(MAX_BITS + 2);
  for (let length = 1; length <= MAX_BITS; length++) offsets[length + 1] = offsets[length] + count[length];
  const symbol = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s] !== 0) symbol[offsets[lengths[s]]++] = s;
  return { count, symbol };
}

const FIXED = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144); lengths.fill(9, 144, 256); lengths.fill(7, 256, 280); lengths.fill(8, 280, 288);
  return { length: buildCode(lengths), distance: buildCode(new Uint8Array(30).fill(5)) };
})();

/**
 * Inflates a raw DEFLATE stream into exactly `rawLength` bytes. Throws InflateError on a
 * malformed stream, on output beyond `rawLength`, or when the stream ends short of it.
 */
export function inflateRaw(input, rawLength) {
  if (!Number.isInteger(rawLength) || rawLength < 0) throw new InflateError("rawLength must be a non-negative integer");
  const out = new Uint8Array(rawLength);
  let inPos = 0, outPos = 0, bitBuffer = 0, bitCount = 0;

  function bits(need) {
    let value = bitBuffer;
    while (bitCount < need) {
      if (inPos >= input.length) throw new InflateError("Unexpected end of compressed data");
      value |= input[inPos++] << bitCount;
      bitCount += 8;
    }
    bitBuffer = value >>> need;
    bitCount -= need;
    return value & ((1 << need) - 1);
  }
  function decode(code) {
    let value = 0, first = 0, index = 0;
    for (let length = 1; length <= MAX_BITS; length++) {
      value |= bits(1);
      const count = code.count[length];
      if (value - count < first) return code.symbol[index + (value - first)];
      index += count;
      first = (first + count) << 1;
      value <<= 1;
    }
    throw new InflateError("Invalid Huffman code");
  }
  function stored() {
    bitBuffer = 0; bitCount = 0;
    if (inPos + 4 > input.length) throw new InflateError("Unexpected end of compressed data");
    const length = input[inPos] | (input[inPos + 1] << 8);
    const check = input[inPos + 2] | (input[inPos + 3] << 8);
    if (length !== (~check & 0xffff)) throw new InflateError("Stored block length check failed");
    inPos += 4;
    if (inPos + length > input.length) throw new InflateError("Unexpected end of compressed data");
    if (outPos + length > rawLength) throw new InflateError("Output exceeds the declared length");
    out.set(input.subarray(inPos, inPos + length), outPos);
    inPos += length; outPos += length;
  }
  function codes(lengthCode, distanceCode) {
    for (;;) {
      const symbol = decode(lengthCode);
      if (symbol < 256) {
        if (outPos >= rawLength) throw new InflateError("Output exceeds the declared length");
        out[outPos++] = symbol;
      } else if (symbol === 256) return;
      else {
        const lengthIndex = symbol - 257;
        if (lengthIndex >= 29) throw new InflateError("Invalid length symbol");
        const length = LENGTH_BASE[lengthIndex] + bits(LENGTH_EXTRA[lengthIndex]);
        const distanceIndex = decode(distanceCode);
        if (distanceIndex >= 30) throw new InflateError("Invalid distance symbol");
        const distance = DISTANCE_BASE[distanceIndex] + bits(DISTANCE_EXTRA[distanceIndex]);
        if (distance > outPos) throw new InflateError("Distance reaches before the start of the output");
        if (outPos + length > rawLength) throw new InflateError("Output exceeds the declared length");
        for (let i = 0; i < length; i++) { out[outPos] = out[outPos - distance]; outPos++; }
      }
    }
  }
  function dynamic() {
    const lengthCount = bits(5) + 257, distanceCount = bits(5) + 1, codeLengthCount = bits(4) + 4;
    if (lengthCount > 286 || distanceCount > 30) throw new InflateError("Too many length or distance codes");
    const codeLengths = new Uint8Array(19);
    for (let i = 0; i < codeLengthCount; i++) codeLengths[CODE_LENGTH_ORDER[i]] = bits(3);
    const codeLengthCode = buildCode(codeLengths);
    const lengths = new Uint8Array(lengthCount + distanceCount);
    for (let index = 0; index < lengths.length;) {
      const symbol = decode(codeLengthCode);
      if (symbol < 16) lengths[index++] = symbol;
      else {
        let value = 0, repeat;
        if (symbol === 16) {
          if (index === 0) throw new InflateError("Repeat with no previous length");
          value = lengths[index - 1]; repeat = 3 + bits(2);
        } else if (symbol === 17) repeat = 3 + bits(3);
        else repeat = 11 + bits(7);
        if (index + repeat > lengths.length) throw new InflateError("Too many code lengths");
        lengths.fill(value, index, index + repeat);
        index += repeat;
      }
    }
    if (lengths[256] === 0) throw new InflateError("No end-of-block code");
    codes(buildCode(lengths.subarray(0, lengthCount)), buildCode(lengths.subarray(lengthCount)));
  }

  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) stored();
    else if (type === 1) codes(FIXED.length, FIXED.distance);
    else if (type === 2) dynamic();
    else throw new InflateError("Invalid block type");
  } while (!last);
  if (outPos !== rawLength) throw new InflateError(`Inflated ${outPos} bytes, not the declared ${rawLength}`);
  return out;
}
