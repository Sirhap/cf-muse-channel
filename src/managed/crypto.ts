/** 纯 Web Standards 媒体加解密与摘要工具（零 Node 依赖，适配 Cloudflare Workers）。 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const trimmed = value.trim();
  const padded = trimmed.length % 4 === 0 ? trimmed : trimmed + "=".repeat(4 - (trimmed.length % 4));
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) throw new Error("invalid_hex_key");
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// ---------- RFC 1321 MD5（微信 getuploadurl 与企微 upload_media_init 校验所需） ----------
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

export function md5Hex(input: Uint8Array): string {
  const bitLen = BigInt(input.length) * 8n;
  const padLen = ((56 - ((input.length + 1) % 64)) + 64) % 64;
  const buf = new Uint8Array(input.length + 1 + padLen + 8);
  buf.set(input, 0);
  buf[input.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(buf.length - 8, Number(bitLen & 0xffffffffn), true);
  view.setUint32(buf.length - 4, Number((bitLen >> 32n) & 0xffffffffn), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(offset + j * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + MD5_K[i] + m[g]) >>> 0;
      const rot = ((sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]))) >>> 0;
      a = d; d = c; c = b; b = (b + rot) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true); outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true); outView.setUint32(12, d0, true);
  return bytesToHex(out);
}

// ---------- FIPS-197 AES-128-ECB（微信 CDN 媒体加解密所需，WebCrypto 不提供 ECB 模式） ----------
const SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

function xtime(x: number): number { return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff; }
function mul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return p;
}

function expandAes128Key(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("invalid_aes128_key");
  const rk = new Uint8Array(176);
  rk.set(key, 0);
  for (let i = 16, r = 1; i < 176; i += 4) {
    let t0 = rk[i - 4], t1 = rk[i - 3], t2 = rk[i - 2], t3 = rk[i - 1];
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ RCON[r++];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    }
    rk[i] = rk[i - 16] ^ t0;
    rk[i + 1] = rk[i - 15] ^ t1;
    rk[i + 2] = rk[i - 14] ^ t2;
    rk[i + 3] = rk[i - 13] ^ t3;
  }
  return rk;
}

function encryptBlock(inp: Uint8Array, inpOff: number, out: Uint8Array, outOff: number, rk: Uint8Array) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[inpOff + i] ^ rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows
    let t = s[1]; s[1] = s[5]; s[5] = s[9]; s[9] = s[13]; s[13] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[15]; s[15] = s[11]; s[11] = s[7]; s[7] = s[3]; s[3] = t;
    if (round < 10) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        const u = a0 ^ a1 ^ a2 ^ a3;
        s[c] ^= u ^ xtime(a0 ^ a1);
        s[c + 1] ^= u ^ xtime(a1 ^ a2);
        s[c + 2] ^= u ^ xtime(a2 ^ a3);
        s[c + 3] ^= u ^ xtime(a3 ^ a0);
      }
    }
    const base = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[base + i];
  }
  out.set(s, outOff);
}

function decryptBlock(inp: Uint8Array, inpOff: number, out: Uint8Array, outOff: number, rk: Uint8Array) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[inpOff + i] ^ rk[160 + i];
  for (let round = 9; round >= 0; round--) {
    // InvShiftRows
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t; t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    const base = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[base + i];
    if (round > 0) {
      for (let c = 0; c < 16; c += 4) {
        const a0 = s[c], a1 = s[c + 1], a2 = s[c + 2], a3 = s[c + 3];
        s[c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    }
  }
  out.set(s, outOff);
}

export function aes128EcbEncrypt(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const rk = expandAes128Key(key);
  const pad = 16 - (plain.length % 16);
  const padded = new Uint8Array(plain.length + pad);
  padded.set(plain, 0);
  padded.fill(pad, plain.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) encryptBlock(padded, i, out, i, rk);
  return out;
}

export function aes128EcbDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("invalid_aes_ciphertext");
  const rk = expandAes128Key(key);
  const plain = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i += 16) decryptBlock(ciphertext, i, plain, i, rk);
  const pad = plain[plain.length - 1];
  if (pad < 1 || pad > 16 || pad > plain.length) throw new Error("invalid_pkcs7_padding");
  for (let i = plain.length - pad; i < plain.length; i++) {
    if (plain[i] !== pad) throw new Error("invalid_pkcs7_padding");
  }
  return plain.subarray(0, plain.length - pad);
}

/** 企微媒体使用 AES-256-CBC（IV = key[0..16]），通过 WebCrypto 硬件解密并兼容 16B/32B PKCS#7 填充。 */
export async function aes256CbcDecrypt(ciphertext: Uint8Array, aesKeyBase64: string): Promise<Uint8Array> {
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("invalid_wecom_ciphertext");
  const keyBytes = base64ToBytes(aesKeyBase64);
  if (keyBytes.length !== 32) throw new Error("invalid_wecom_aes_key");
  const iv = keyBytes.subarray(0, 16);
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), { name: "AES-CBC" }, false, ["decrypt"]);
  // WebCrypto AES-CBC 强制按 16 字节 PKCS#7 校验，追加一个加密的 0x10 填充块绕过 32 字节填充报错，再自行校验剥离。
  const padBlockPlain = new Uint8Array(16).fill(16);
  const lastBlock = ciphertext.subarray(ciphertext.length - 16);
  const encKey = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes), { name: "AES-CBC" }, false, ["encrypt"]);
  const dummy = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: Uint8Array.from(lastBlock) },
    encKey,
    padBlockPlain,
  )).subarray(0, 16);
  const extended = new Uint8Array(ciphertext.length + 16);
  extended.set(ciphertext, 0);
  extended.set(dummy, ciphertext.length);
  const rawPlain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: Uint8Array.from(iv) },
    key,
    extended,
  ));
  if (!rawPlain.length) throw new Error("empty_plaintext");
  const pad = rawPlain[rawPlain.length - 1];
  if (pad >= 1 && pad <= 32 && pad <= rawPlain.length) {
    let valid = true;
    for (let i = rawPlain.length - pad; i < rawPlain.length; i++) {
      if (rawPlain[i] !== pad) { valid = false; break; }
    }
    if (valid) return rawPlain.subarray(0, rawPlain.length - pad);
  }
  return rawPlain;
}
