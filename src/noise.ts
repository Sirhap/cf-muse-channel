import { x25519 } from '@noble/curves/ed25519';
import { bytesField as b, numberField as n, fields, getBytes, getNumber, join, utf8 } from './wire';

const EMPTY: Uint8Array = new Uint8Array();
function owned(value: Uint8Array): ArrayBuffer { return Uint8Array.from(value).buffer; }
async function hash(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', owned(value)));
}
async function mac(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', owned(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, owned(value)));
}
async function hkdf(key: Uint8Array, value: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
  const temp = await mac(key, value), first = await mac(temp, Uint8Array.of(1));
  return [first, await mac(temp, join(first, Uint8Array.of(2)))];
}
class Cipher {
  private nonce = 0n;
  private key?: CryptoKey;
  async initialize(bytes: Uint8Array): Promise<void> {
    this.key = await crypto.subtle.importKey('raw', owned(bytes), 'AES-GCM', false, ['encrypt', 'decrypt']); this.nonce = 0n;
  }
  private iv(): Uint8Array {
    const iv = new Uint8Array(12); new DataView(iv.buffer).setBigUint64(4, this.nonce, false); return iv;
  }
  async crypt(data: Uint8Array, additional: Uint8Array, decrypt = false): Promise<Uint8Array> {
    if (!this.key) return data;
    if (this.nonce >= 0xffffffffffffffffn) throw new Error('noise_nonce_exhausted');
    const algorithm = { name: 'AES-GCM', iv: owned(this.iv()), additionalData: owned(additional), tagLength: 128 };
    const result = new Uint8Array(await crypto.subtle[decrypt ? 'decrypt' : 'encrypt'](algorithm, this.key, owned(data)));
    this.nonce += 1n; return result;
  }
}

/** Noise XX initiator; TLS authenticates the fixed gateway, Noise protects RPC frames. */
export class NoiseXX {
  private chaining: Uint8Array = EMPTY;
  private transcript: Uint8Array = EMPTY;
  private cipher = new Cipher();
  private send = new Cipher();
  private receive = new Cipher();
  private ephemeral: Uint8Array;
  private staticKey: Uint8Array;
  constructor(ephemeral = crypto.getRandomValues(new Uint8Array(32)), staticKey = crypto.getRandomValues(new Uint8Array(32))) {
    this.ephemeral = ephemeral; this.staticKey = staticKey;
  }
  private async mixHash(data: Uint8Array) { this.transcript = await hash(join(this.transcript, data)); }
  private async mixKey(data: Uint8Array) {
    const [chaining, key] = await hkdf(this.chaining, data); this.chaining = chaining; await this.cipher.initialize(key);
  }
  private async encryptHandshake(data: Uint8Array) {
    const encrypted = await this.cipher.crypt(data, this.transcript); await this.mixHash(encrypted); return encrypted;
  }
  private async decryptHandshake(data: Uint8Array) {
    const plain = await this.cipher.crypt(data, this.transcript, true); await this.mixHash(data); return plain;
  }
  async first(): Promise<Uint8Array> {
    const name = utf8.encode('Noise_XX_25519_AESGCM_SHA256');
    this.transcript = name.length <= 32 ? join(name, new Uint8Array(32 - name.length)) : await hash(name);
    this.chaining = this.transcript;
    await this.mixHash(EMPTY); // Empty prologue is still hashed by the Noise protocol.
    const publicKey = x25519.getPublicKey(this.ephemeral); await this.mixHash(publicKey);
    return join(publicKey, await this.encryptHandshake(EMPTY));
  }
  async third(second: Uint8Array): Promise<Uint8Array> {
    if (second.length < 96) throw new Error('noise_invalid_handshake');
    const remoteEphemeral = second.slice(0, 32); await this.mixHash(remoteEphemeral);
    await this.mixKey(x25519.getSharedSecret(this.ephemeral, remoteEphemeral));
    const remoteStatic = await this.decryptHandshake(second.slice(32, 80));
    await this.mixKey(x25519.getSharedSecret(this.ephemeral, remoteStatic));
    await this.decryptHandshake(second.slice(80));
    const encryptedStatic = await this.encryptHandshake(x25519.getPublicKey(this.staticKey));
    await this.mixKey(x25519.getSharedSecret(this.staticKey, remoteEphemeral));
    const final = join(encryptedStatic, await this.encryptHandshake(EMPTY));
    const [send, receive] = await hkdf(this.chaining, EMPTY);
    await this.send.initialize(send); await this.receive.initialize(receive);
    return final;
  }
  encrypt(data: Uint8Array) { return this.send.crypt(data, EMPTY); }
  decrypt(data: Uint8Array) { return this.receive.crypt(data, EMPTY, true); }
}

class SocketFrames {
  private queue: Uint8Array[] = [];
  private waiter?: { resolve: (data: Uint8Array) => void; reject: (error: Error) => void };
  private ended = false;
  constructor(readonly socket: WebSocket) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) { this.stop(); return; }
      const data = new Uint8Array(event.data);
      if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve(data); }
      else if (this.queue.length < 128) this.queue.push(data);
      else this.stop();
    });
    socket.addEventListener('close', () => this.stop()); socket.addEventListener('error', () => this.stop());
    socket.accept();
  }
  private stop() { this.ended = true; this.waiter?.reject(new Error('noise_socket_closed')); this.waiter = undefined; }
  read(timeout = 15000): Promise<Uint8Array> {
    const ready = this.queue.shift(); if (ready) return Promise.resolve(ready);
    if (this.ended) return Promise.reject(new Error('noise_socket_closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = undefined; reject(new Error('noise_read_timeout')); }, timeout);
      this.waiter = { resolve: (data) => { clearTimeout(timer); resolve(data); }, reject: (error) => { clearTimeout(timer); reject(error); } };
    });
  }
  close() { this.stop(); try { this.socket.close(1000, 'RPC complete'); } catch { /* Already closed. */ } }
}

/** Bounded unary Muse RPC used by Worker-owned approval polling and channel administration. */
export class MuseRpc {
  private stream = 1;
  private fragments = new Map<string, { total: number; bytes: number; parts: Map<number, Uint8Array> }>();
  private constructor(private frames: SocketFrames, private noise: NoiseXX) {}
  static async connect(socket: WebSocket): Promise<MuseRpc> {
    const frames = new SocketFrames(socket), noise = new NoiseXX();
    try {
      socket.send(owned(await noise.first()));
      socket.send(owned(await noise.third(await frames.read())));
      return new MuseRpc(frames, noise);
    } catch (error) { frames.close(); throw error; }
  }
  close() { this.frames.close(); }
  async call(path: string, service = 1, method = 'GET', body?: unknown): Promise<unknown> {
    const stream = this.stream++;
    let request = join(b(1, method), b(2, path), b(3, join(b(1, 'x-request-id'), b(2, crypto.randomUUID()))), n(5, 1));
    if (body !== undefined) request = join(request, b(3, join(b(1, 'content-type'), b(2, 'application/json'))), b(4, JSON.stringify(body)));
    const frame = join(n(1, stream), b(2, request));
    const envelope = join(n(1, service), b(2, frame));
    const transport = join(n(1, BigInt(stream)), n(2, 0), n(3, 1), b(4, envelope));
    this.frames.socket.send(owned(await this.noise.encrypt(transport)));
    const deadline = Date.now() + 20000;
    let status = 0, length = 0;
    const chunks: Uint8Array[] = [];
    while (Date.now() < deadline) {
      const record = fields(await this.noise.decrypt(await this.frames.read(Math.max(1, deadline - Date.now()))));
      const total = Number(getNumber(record, 3)) || 1, index = Number(getNumber(record, 2));
      let payload = getBytes(record, 4);
      if (total > 1) {
        if (total > 256 || index >= total) throw new Error('rpc_fragment_limit');
        const id = getNumber(record, 1).toString();
        const group = this.fragments.get(id) ?? { total, bytes: 0, parts: new Map() };
        if (group.total !== total || group.parts.has(index)) throw new Error('rpc_invalid_fragment');
        group.parts.set(index, payload); group.bytes += payload.length;
        if (group.bytes > 2 * 1024 * 1024 || this.fragments.size > 16) throw new Error('rpc_body_limit');
        this.fragments.set(id, group);
        if (group.parts.size !== total) continue;
        payload = join(...Array.from({ length: total }, (_, i) => group.parts.get(i)!)); this.fragments.delete(id);
      }
      const serviceResponse = fields(payload), responseFrame = fields(getBytes(serviceResponse, 1));
      if (Number(getNumber(responseFrame, 1)) !== stream) continue;
      if (responseFrame.has(5)) throw new Error('rpc_stream_reset');
      let end = false, chunk = EMPTY;
      if (responseFrame.has(3)) {
        const response = fields(getBytes(responseFrame, 3)); status = Number(getNumber(response, 1));
        chunk = getBytes(response, 3); end = Boolean(getNumber(response, 4));
      } else if (responseFrame.has(4)) {
        const response = fields(getBytes(responseFrame, 4)); chunk = getBytes(response, 1); end = Boolean(getNumber(response, 2));
      }
      length += chunk.length; if (length > 2 * 1024 * 1024) throw new Error('rpc_body_limit'); chunks.push(chunk);
      if (end) {
        if (status < 200 || status >= 300) throw new Error(`rpc_http_${status}`);
        const parsed: unknown = length ? JSON.parse(new TextDecoder().decode(join(...chunks))) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const object = parsed as Record<string, unknown>;
          if (object.ok === false || object.error) throw new Error('rpc_application_error');
          return object.result ?? parsed;
        }
        return parsed;
      }
    }
    throw new Error('rpc_incomplete_body');
  }
}
