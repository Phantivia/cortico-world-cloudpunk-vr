/** TCP 客户端：连游戏里的 CloudpunkVR 插件(docs/protocol.md),一行一个 JSON,断线后每 2 秒重连，直到 close()。 */
import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';

export const PROTOCOL = 2;
const RECONNECT_MS = 2000;

export interface Quest {
  id: string;
  who?: string;
  text: string;
  progress?: string;
  marker?: [number, number, number];
  markerKind?: string;
  distance?: number;
  /** 任务在另一层：marker 是游戏把标记挪到的升降梯 */
  otherLevel?: boolean;
}

/** 插件每秒 4 次的状态帧，只放事实；措辞在 render.ts。 */
export interface GameState {
  type: 'state';
  /** loading / menu / dialogue / map / window / car / car_chase / foot / none */
  mode: string;
  vr: boolean;
  sector?: string;
  pos?: [number, number, number];
  money?: number;
  car?: { speedKmh: number; fuel: number; maxFuel: number; floor: number; inParking: boolean; pos: [number, number, number] };
  quests?: Quest[];
  dialogue?: { speaker: string; text: string; remote?: boolean };
  interact?: string;
  autopilot?: { phase: string; target?: string; goal?: [number, number, number]; remainingM?: number; next?: { kind: string; inM: number } };
}

export interface GameFrame {
  type: 'hello' | 'reply' | 'event' | 'state';
  id?: number;
  ok?: boolean;
  error?: string;
  result?: unknown;
  name?: string;
  protocol?: number;
  vr?: boolean;
  [key: string]: unknown;
}

/** 事件:hello(frame)、event(frame)、state(GameState)、disconnect()。 */
export class GameBridge extends EventEmitter {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (f: GameFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private closed = true;
  private retry: NodeJS.Timeout | null = null;
  hello: GameFrame | null = null;

  get connected(): boolean {
    return this.hello !== null;
  }

  open(port: number): void {
    this.closed = false;
    this.dial(port);
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop(new Error('bridge closed'));
  }

  /** 请求-回复;插件在主线程上处理。 */
  request(method: string, args: Record<string, unknown>, timeoutMs: number): Promise<GameFrame> {
    const socket = this.socket;
    if (!socket || !this.hello) return Promise.reject(new Error('游戏未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`游戏 ${timeoutMs / 1000} 秒内没有处理 ${method}(游戏卡住或在读条)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ type: 'request', id, method, args })}\n`);
    });
  }

  /** 不要回复的消息(config / corti_line / danmaku / asr …);未连接时丢弃。 */
  notify(payload: Record<string, unknown>): void {
    if (this.socket && this.hello) this.socket.write(`${JSON.stringify(payload)}\n`);
  }

  private dial(port: number): void {
    if (this.closed) return;
    const socket = createConnection({ host: '127.0.0.1', port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let frame: GameFrame;
        try {
          frame = JSON.parse(line) as GameFrame;
        } catch {
          continue;
        }
        this.receive(frame);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasConnected = this.hello !== null;
      this.drop(new Error('游戏连接已断开'));
      if (wasConnected) this.emit('disconnect');
      if (!this.closed) this.retry = setTimeout(() => this.dial(port), RECONNECT_MS);
    });
  }

  private drop(error: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.hello = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    socket?.destroy();
  }

  private receive(frame: GameFrame): void {
    if (frame.type === 'hello') {
      this.hello = frame;
      this.emit('hello', frame);
    } else if (frame.type === 'reply' && frame.id !== undefined) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      p.resolve(frame);
    } else if (frame.type === 'event') {
      this.emit('event', frame);
    } else if (frame.type === 'state') {
      this.emit('state', frame as unknown as GameState);
    }
  }
}
