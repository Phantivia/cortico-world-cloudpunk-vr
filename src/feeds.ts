/**
 * 三条接线都填 OBS 里那条 overlay 地址(vtuber World 的演出、B 站直播间 World、语音识别 World),这里换成同源的
 * `/stream`(SSE)读数据：这些 overlay 页面本身就是订这条流渲染的，事件只增不改。游戏里用原生文字重画，不渲染网页。
 */
import type { Logger } from 'cortico/core/types.ts';

const RETRY_MS = 3000;

/** overlay 地址 -> 同源的 /stream;认不出来返回 null。直接给 /stream 也行。 */
export function streamUrlOf(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.origin}/stream`;
}

export type FeedState = 'off' | 'connecting' | 'live' | 'error';

/** 一条 SSE 订阅：断了每 3 秒重连，直到 stop()。只在要用的时候开(vtuber 把有订阅者当作在播)。 */
export class SseFeed {
  private abort: AbortController | null = null;
  private retry: NodeJS.Timeout | null = null;
  private warned = false;
  state: FeedState = 'off';
  detail = '';
  /** 收到的消息数(给面板看接线活没活)。 */
  received = 0;
  lastAt = 0;
  private url = '';

  constructor(
    private readonly name: string,
    private readonly onMessage: (msg: Record<string, unknown>) => void,
    private readonly log: () => Logger | undefined,
  ) {}

  get running(): boolean {
    return this.abort !== null || this.retry !== null;
  }

  /** 按地址开;地址变了就重开，空地址就停。 */
  sync(overlayUrl: string, wanted: boolean): void {
    const url = wanted ? streamUrlOf(overlayUrl) ?? '' : '';
    if (url === this.url && (this.running || !url)) return;
    this.stop();
    this.url = url;
    if (!url) {
      this.state = 'off';
      this.detail = wanted && overlayUrl.trim() ? `认不出地址 ${overlayUrl}` : '';
      return;
    }
    void this.connect();
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
    this.url = '';
    this.state = 'off';
  }

  private async connect(): Promise<void> {
    const url = this.url;
    const ac = new AbortController();
    this.abort = ac;
    this.state = 'connecting';
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.warned = false;
      this.state = 'live';
      this.detail = url;
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        for (let end = buf.indexOf('\n\n'); end !== -1; end = buf.indexOf('\n\n')) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(data);
          } catch {
            continue;
          }
          if (!msg || typeof msg !== 'object') continue;
          this.received++;
          this.lastAt = Date.now();
          try {
            this.onMessage(msg as Record<string, unknown>);
          } catch (err) {
            this.log()?.warn(`cloudpunk.${this.name}`, String(err));
          }
        }
      }
      throw new Error('流结束了');
    } catch (err) {
      if (ac.signal.aborted) return;
      this.state = 'error';
      this.detail = `${url}:${(err as Error).message ?? String(err)}`;
      if (!this.warned) this.log()?.warn(`cloudpunk.${this.name}`, `${url} 不可用：${String(err)},每 ${RETRY_MS / 1000} 秒重试`);
      this.warned = true;
    }
    if (this.abort !== ac) return;
    this.abort = null;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, RETRY_MS);
  }
}

export type OverlayKind = 'vtuber' | 'bilibili' | 'asr';

/** overlay 页的 <title> -> 是哪个 World 的。 */
export function overlayKindOf(html: string): OverlayKind | null {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  if (/Bilibili Overlay/i.test(title)) return 'bilibili';
  if (/语音识别/.test(title)) return 'asr';
  if (/演出/.test(title)) return 'vtuber';
  return null;
}

/** 看一个 overlay 地址是哪种、通不通。 */
export async function probeOverlay(url: string, timeoutMs = 1500): Promise<{ ok: boolean; kind: OverlayKind | null; detail: string }> {
  const stream = streamUrlOf(url);
  if (!stream) return { ok: false, kind: null, detail: '认不出地址' };
  const page = stream.replace(/\/stream$/, '/overlay');
  try {
    const res = await fetch(page, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, kind: null, detail: `HTTP ${res.status}` };
    const kind = overlayKindOf(await res.text());
    return { ok: true, kind, detail: kind ? '' : '不是认识的 overlay' };
  } catch (err) {
    return { ok: false, kind: null, detail: (err as Error).name === 'TimeoutError' ? '没有响应' : '连不上(那个 World 没开?)' };
  }
}

/** 在本机常用端口上找三个 World 的 overlay。 */
export async function detectOverlays(ports: readonly number[] = defaultPorts()): Promise<Partial<Record<OverlayKind, string>>> {
  const found: Partial<Record<OverlayKind, string>> = {};
  await Promise.all(ports.map(async (port) => {
    const url = `http://127.0.0.1:${port}/overlay`;
    const r = await probeOverlay(url, 800);
    if (r.ok && r.kind && !found[r.kind]) found[r.kind] = url;
  }));
  return found;
}

function defaultPorts(): number[] {
  const ports: number[] = [];
  for (let p = 7780; p <= 7830; p++) ports.push(p);
  for (let p = 8780; p <= 8800; p++) ports.push(p);
  return ports;
}
