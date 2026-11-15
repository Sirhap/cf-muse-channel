/** Minimal bounded protobuf codec for the pinned Muse gateway envelopes. */
export const utf8 = new TextEncoder();
export function join(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
export function varint(value: number | bigint): Uint8Array {
  let n = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  while (n > 127n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n));
  return Uint8Array.from(out);
}
export function numberField(field: number, value: number | bigint): Uint8Array {
  return join(varint(field << 3), varint(value));
}
export function bytesField(field: number, value: Uint8Array | string): Uint8Array {
  const data = typeof value === 'string' ? utf8.encode(value) : value;
  return join(varint((field << 3) | 2), varint(data.length), data);
}
export function fields(data: Uint8Array): Map<number, (Uint8Array | bigint)[]> {
  const result = new Map<number, (Uint8Array | bigint)[]>();
  let offset = 0;
  function read(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n && offset < data.length; shift += 7n) {
      const byte = data[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('invalid_protobuf_varint');
  }
  while (offset < data.length) {
    const tag = Number(read()), field = tag >> 3, wire = tag & 7;
    if (field < 1) throw new Error('invalid_protobuf_field');
    let value: Uint8Array | bigint;
    if (wire === 0) value = read();
    else if (wire === 2) {
      const length = Number(read());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) throw new Error('invalid_protobuf_length');
      value = data.slice(offset, offset + length); offset += length;
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (offset + length > data.length) throw new Error('invalid_protobuf_length');
      value = data.slice(offset, offset + length); offset += length;
    } else throw new Error('unsupported_protobuf_wire');
    result.set(field, [...(result.get(field) ?? []), value]);
  }
  return result;
}
export function getBytes(data: Map<number, (Uint8Array | bigint)[]>, field: number): Uint8Array {
  const value = data.get(field)?.[0];
  return value instanceof Uint8Array ? value : new Uint8Array();
}
export function getNumber(data: Map<number, (Uint8Array | bigint)[]>, field: number): bigint {
  const value = data.get(field)?.[0];
  return typeof value === 'bigint' ? value : 0n;
}
