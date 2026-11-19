import { x25519 } from '@noble/curves/ed25519';
import { bytesField as b, numberField as n, fields, getBytes, getNumber, join, utf8 } from './wire';

const EMPTY: Uint8Array = new Uint8Array();
const MAX_SOCKET_QUEUE = 1024;
const MAX_STREAM_QUEUE = 1024;
type FrameFields = ReturnType<typeof fields>;
interface StreamBuffer {
  queue: FrameFields[];
  waiter?: { resolve: (frame: FrameFields) => void; reject: (error: Error) => void };
}
/** 整块 ArrayBuffer 直接零拷贝透传，仅在切片视图时复制。 */
function owned(value: Uint8Array): ArrayBuffer {
  if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength && value.buffer instanceof ArrayBuffer) {
    return value.buffer;
  }
  return Uint8Array.from(value).buffer;
}
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
      else if (this.queue.length < MAX_SOCKET_QUEUE) this.queue.push(data);
      else this.stop();
    });
    socket.addEventListener('close', () => this.stop()); socket.addEventListener('error', () => this.stop());
    socket.accept();
  }
  private stop() { this.ended = true; this.waiter?.reject(new Error('noise_socket_closed')); this.waiter = undefined; }
  /** timeout <= 0 表示持久等待（由上层 stream 独立管理超时）。 */
  read(timeout = 15000): Promise<Uint8Array> {
    const ready = this.queue.shift(); if (ready) return Promise.resolve(ready);
    if (this.ended) return Promise.reject(new Error('noise_socket_closed'));
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => { this.waiter = undefined; reject(new Error('noise_read_timeout')); }, timeout) : undefined;
      this.waiter = {
        resolve: (data) => { if (timer !== undefined) clearTimeout(timer); resolve(data); },
        reject: (error) => { if (timer !== undefined) clearTimeout(timer); reject(error); },
      };
    });
  }
  close() { this.stop(); try { this.socket.close(1000, 'RPC complete'); } catch { /* Already closed. */ } }
}

/** 支持流级多路复用与自动排空未订阅流响应的 Noise RPC 客户端。 */
export class MuseRpc {
  private stream = 1;
  private fragments = new Map<string, { total: number; bytes: number; parts: Map<number, Uint8Array> }>();
  private streams = new Map<number, StreamBuffer>();
  private sendSerial: Promise<void> = Promise.resolve();
  private closedError?: Error;
  private constructor(private frames: SocketFrames, private noise: NoiseXX) {
    void this.pumpIncoming();
  }
  static async connect(socket: WebSocket): Promise<MuseRpc> {
    const frames = new SocketFrames(socket), noise = new NoiseXX();
    try {
      socket.send(owned(await noise.first()));
      socket.send(owned(await noise.third(await frames.read())));
      return new MuseRpc(frames, noise);
    } catch (error) { frames.close(); throw error; }
  }
  close() {
    this.failAll(new Error('noise_socket_closed'));
    this.frames.close();
  }
  private failAll(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const buffer of this.streams.values()) {
      const waiter = buffer.waiter;
      buffer.waiter = undefined;
      waiter?.reject(error);
    }
    this.streams.clear();
    this.fragments.clear();
  }
  /** 后台单泵持续解密并按 stream_id 分发；无人消费的流（如 fire-and-forget /chat/stream）立即丢弃，避免积压撑爆队列。 */
  private async pumpIncoming() {
    try {
      for (;;) {
        const frame = await this.decodeNextFrame();
        const streamId = Number(getNumber(frame, 1));
        const target = this.streams.get(streamId);
        if (!target) continue;
        if (target.waiter) {
          const waiter = target.waiter;
          target.waiter = undefined;
          waiter.resolve(frame);
        } else if (target.queue.length < MAX_STREAM_QUEUE) {
          target.queue.push(frame);
        } else {
          this.streams.delete(streamId);
        }
      }
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error('noise_socket_closed'));
      this.frames.close();
    }
  }
  private async decodeNextFrame(): Promise<FrameFields> {
    for (;;) {
      const record = fields(await this.noise.decrypt(await this.frames.read(0)));
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
      const serviceResponse = fields(payload);
      return fields(getBytes(serviceResponse, 1));
    }
  }
  private readStream(stream: number, timeout: number): Promise<FrameFields> {
    const target = this.streams.get(stream);
    if (!target) return Promise.reject(this.closedError ?? new Error('noise_socket_closed'));
    const ready = target.queue.shift();
    if (ready) return Promise.resolve(ready);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { target.waiter = undefined; reject(new Error('noise_read_timeout')); }, timeout);
      target.waiter = {
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }
  /** 串行化加密与发送，确保多路复用并发请求时发送端 AES-GCM nonce 严格有序。 */
  private sendRequest(stream: number, path: string, service: number, method: string, body?: unknown): Promise<number> {
    const work = this.sendSerial.then(async () => {
      if (this.closedError) throw this.closedError;
      let request = join(b(1, method), b(2, path), b(3, join(b(1, 'x-request-id'), b(2, crypto.randomUUID()))), n(5, 1));
      if (body !== undefined) request = join(request, b(3, join(b(1, 'content-type'), b(2, 'application/json'))), b(4, JSON.stringify(body)));
      const frame = join(n(1, stream), b(2, request));
      const envelope = join(n(1, service), b(2, frame));
      const transport = join(n(1, BigInt(stream)), n(2, 0), n(3, 1), b(4, envelope));
      this.frames.socket.send(owned(await this.noise.encrypt(transport)));
      return stream;
    });
    this.sendSerial = work.then(() => undefined, () => undefined);
    return work;
  }
  /** Send once. Caller must persist an intent before invoking this for a chat turn. */
  open(path: string, service = 0, method = 'POST', body?: unknown) {
    const stream = this.stream++;
    return this.sendRequest(stream, path, service, method, body);
  }

  /** 订阅服务端事件流；读取前先注册 stream 缓冲避免极速回包竞态。 */
  async subscribe(path: string, body: unknown, onEvent: (event: unknown) => void) {
    if (this.closedError) throw this.closedError;
    const stream = this.stream++;
    this.streams.set(stream, { queue: [] });
    try {
      await this.sendRequest(stream, path, 0, 'POST', body);
      let buffer = '';
      const decoder = new TextDecoder();
      for (;;) {
        const frame = await this.readStream(stream, 120000);
        if (frame.has(5)) throw new Error('rpc_stream_reset');
        const response = frame.has(3) ? fields(getBytes(frame, 3)) : fields(getBytes(frame, 4));
        if (frame.has(3)) {
          const status = Number(getNumber(response, 1));
          if (status < 200 || status >= 300) throw new Error('subscription_refused');
        }
        buffer += decoder.decode(getBytes(response, frame.has(3) ? 3 : 1), { stream: true });
        if (buffer.length > 2 * 1024 * 1024) throw new Error('subscription_limit');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.trim()) onEvent(JSON.parse(line));
        }
        if (Boolean(getNumber(response, frame.has(3) ? 4 : 2))) {
          buffer += decoder.decode();
          if (buffer.trim()) onEvent(JSON.parse(buffer));
          return;
        }
      }
    } finally {
      this.streams.delete(stream);
    }
  }
  async call(path: string, service = 1, method = 'GET', body?: unknown, timeout = 20000): Promise<unknown> {
    if (this.closedError) throw this.closedError;
    const stream = this.stream++;
    this.streams.set(stream, { queue: [] });
    try {
      await this.sendRequest(stream, path, service, method, body);
      const deadline = Date.now() + timeout;
      let status = 0, length = 0;
      const chunks: Uint8Array[] = [];
      while (Date.now() < deadline) {
        const responseFrame = await this.readStream(stream, Math.max(1, deadline - Date.now()));
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
    } finally {
      this.streams.delete(stream);
    }
  }
}
