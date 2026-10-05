/*
 * CRC-32, in the two shapes ZIP needs.
 *
 * `crc32` is the value stored in the headers; `crc32Byte` / `crc32Update` are
 * the raw steps, because ZipCrypto's key schedule hashes bytes without the
 * xor-in/out that the standard CRC applies.
 */

type BufferLike = Uint8Array;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32Byte(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

export function crc32Update(crc: number, data: BufferLike): number {
  let c = crc >>> 0;
  for (let i = 0; i < data.length; i++) c = crc32Byte(c, data[i]);
  return c >>> 0;
}

/** Standard CRC-32 of a whole buffer (the value ZIP stores in its headers). */
export function crc32(data: BufferLike): number {
  return (crc32Update(0xffffffff, data) ^ 0xffffffff) >>> 0;
}
