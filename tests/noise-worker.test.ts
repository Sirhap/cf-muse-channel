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
