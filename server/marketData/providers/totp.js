/* Time-based one-time password (RFC 6238, SHA-1, 30 s, 6 digits): the same code an
   authenticator app shows. Used to sign the server in to Angel One without a person. */
import crypto from 'node:crypto';

export function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch); if (i < 0) throw new Error('TOTP secret is not valid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}
export function totp(secret, timeMs = Date.now(), { digits = 6, step = 30 } = {}) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / step)));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest(), o = mac[mac.length - 1] & 0xf;
  const code = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}
