import { expect, it } from 'vitest';
import fixture from './fixtures/noise-python.json';
import { NoiseXX } from '../src/noise';
import { fields, getBytes, getNumber, join, bytesField, numberField } from '../src/wire';
const unhex = (value: string) => Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
const hex = (value: Uint8Array) => Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
it('interoperates with Python Noise XX handshake and both directional transport keys', async () => {
 const noise = new NoiseXX(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
 expect(hex(await noise.first())).toBe(fixture.first);
 expect(hex(await noise.third(unhex(fixture.second)))).toBe(fixture.third);
 expect(hex(await noise.encrypt(new TextEncoder().encode('worker-rpc')))).toBe(fixture.encrypted_request);
 expect(new TextDecoder().decode(await noise.decrypt(unhex(fixture.encrypted_response)))).toBe('muse-response');
});
it('rejects altered handshake ciphertext', async () => {
 const noise = new NoiseXX(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
 await noise.first();const second=unhex(fixture.second);second[40]^=1;
 await expect(noise.third(second)).rejects.toThrow();
});
it('encodes and decodes signed 64-bit IDs and bounded protobuf bytes', () => {
 const result=fields(join(numberField(1,-1n),bytesField(4,'payload')));
 expect(getNumber(result,1)).toBe(0xffffffffffffffffn);
 expect(new TextDecoder().decode(getBytes(result,4))).toBe('payload');
 expect(()=>fields(Uint8Array.of(34,100,0))).toThrow();
});

it('fragments outbound Noise RPC payloads exceeding 48 KiB into compliant <=64 KiB frames', async () => {
 const { MuseRpc } = await import('../src/noise');
 const sentFrames: Uint8Array[] = [];
 const fakeFrames = {
   read: async () => new Promise<Uint8Array>(() => {}),
   close: () => {},
   socket: { send: (buf: ArrayBuffer) => { sentFrames.push(new Uint8Array(buf)); } },
 };
 const passthroughNoise = { encrypt: async (d: Uint8Array) => d, decrypt: async (d: Uint8Array) => d };
 const rpc = new (MuseRpc as unknown as new (f: unknown, n: unknown) => { open: (p: string, s: number, m: string, b: unknown) => Promise<number> })(fakeFrames, passthroughNoise);
 const largeImageB64 = 'A'.repeat(120 * 1024);
 await rpc.open('/chat/stream', 0, 'POST', { items: [{ type: 'image', data_base64: largeImageB64 }] });
 expect(sentFrames.length).toBeGreaterThanOrEqual(3);
 for (const f of sentFrames) expect(f.length).toBeLessThan(65535);
 const decoded = sentFrames.map((f) => fields(f));
 const total = Number(getNumber(decoded[0], 3));
 expect(total).toBe(sentFrames.length);
 expect(decoded.map((d, i) => Number(getNumber(d, 2)) === i).every(Boolean)).toBe(true);
 const reassembled = join(...decoded.map((d) => getBytes(d, 4)));
 expect(new TextDecoder().decode(reassembled)).toContain(largeImageB64);
});
