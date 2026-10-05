/*
 * The traditional PKWARE stream cipher ("ZipCrypto").
 *
 * Deliberately not AES-256: the password is six digits — about 20 bits — so AES
 * would not meaningfully raise the cost of an attack, while an AES archive is
 * refused by Windows Explorer and macOS Archive Utility. An export of one's own
 * images is worth more when it opens by double-click anywhere.
 *
 * Format trap: the keystream byte comes from the key state *before* the state is
 * advanced with the plaintext byte. Reversing those two steps produces an
 * archive that decrypts to garbage after the first byte.
 */

import { crc32Byte } from "./crc32";
import { utf8Bytes } from "./bytes";

type BufferLike = Uint8Array;

export class ZipCrypto {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: string) {
    for (const b of utf8Bytes(password)) this.update(b);
  }

  private update(byte: number): void {
    this.k0 = crc32Byte(this.k0, byte);
    this.k1 = (this.k1 + (this.k0 & 0xff)) >>> 0;
    this.k1 = (Math.imul(this.k1, 134775813) + 1) >>> 0;
    this.k2 = crc32Byte(this.k2, (this.k1 >>> 24) & 0xff);
  }

  /** Keystream byte for the *current* state — read it before advancing. */
  private streamByte(): number {
    const temp = (this.k2 | 2) & 0xffff;
    return ((Math.imul(temp, temp ^ 1) >> 8) & 0xff) >>> 0;
  }

  /** Encrypt in place, advancing the state with each plaintext byte. */
  encrypt(data: BufferLike): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const plain = data[i];
      out[i] = plain ^ this.streamByte();
      this.update(plain);
    }
    return out;
  }

  /** Keystream-only pass, for verification in tests. */
  decrypt(data: BufferLike): Uint8Array {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const cipher = data[i];
      out[i] = cipher ^ this.streamByte();
      this.update(out[i]);
    }
    return out;
  }

  /**
   * The 12-byte preamble: 11 random bytes and a check byte drawn from the high
   * byte of the CRC. It is encrypted with the same stream as the data.
   */
  header(crc: number, random: BufferLike): Uint8Array {
    const plain = new Uint8Array(12);
    plain.set(random.subarray(0, 11), 0);
    plain[11] = (crc >>> 24) & 0xff;
    return this.encrypt(plain);
  }
}
