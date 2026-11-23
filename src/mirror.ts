/**
 * The stream's overlay layer, mirrored into the headset. OBS lays browser sources over the game capture (the vtuber
 * World's stage overlay, the bilibili live-room overlay with its board and comments, the speech recognition subtitles);
 * the operator in VR sees none of it. Here every such page is opened in a headless Edge (Chrome as a fallback) with a
 * transparent background and screencast as PNG; a changed layer goes to the game at most `fps` times a second, and the
 * plugin lays the layers out the way OBS does on one panel in front of the eyes.
 *
 * The layout comes from OBS's own scene file (position and scale of each visible browser source, the canvas size from
 * the profile), so the headset shows what the stream shows. Without OBS the overlays found on this PC are laid full size.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export interface OverlayLayer {
  name: string;
  url: string;
  /** Top-left corner on the canvas and the size the page is shown at, in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The page's own size (OBS browser source width/height). */
  pageW: number;
  pageH: number;
  on: boolean;
}

export interface OverlayLayout {
  canvas: [number, number];
  layers: OverlayLayer[];
  /** Where it came from, for the panel. */
  source: string;
}

export function parseLayout(text: string): OverlayLayout | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text) as Partial<OverlayLayout>;
    if (!Array.isArray(v.canvas) || !Array.isArray(v.layers)) return null;
    return {
      canvas: [Number(v.canvas[0]) || 1920, Number(v.canvas[1]) || 1080],
      layers: v.layers.filter((l) => l && typeof l.url === 'string').map((l) => ({
        name: String(l.name ?? l.url), url: String(l.url), x: Number(l.x) || 0, y: Number(l.y) || 0,
        w: Number(l.w) || 1920, h: Number(l.h) || 1080, pageW: Number(l.pageW) || 1920, pageH: Number(l.pageH) || 1080, on: l.on !== false,
      })),
      source: String(v.source ?? ''),
    };
  } catch {
    return null;
  }
}

/** The overlays found on this PC, each laid over the whole canvas. */
export function stackedLayout(urls: Array<{ name: string; url: string }>, canvas: [number, number] = [1920, 1080]): OverlayLayout {
  return {
    canvas,
    layers: urls.map((u) => ({ name: u.name, url: u.url, x: 0, y: 0, w: canvas[0], h: canvas[1], pageW: 1920, pageH: 1080, on: true })),
    source: '本机找到的 overlay,铺满',
  };
}

interface ObsItem { name: string; visible?: boolean; pos?: { x: number; y: number }; scale?: { x: number; y: number }; bounds_type?: number; bounds?: { x: number; y: number }; align?: number }
interface ObsSource { name: string; id: string; settings?: { url?: string; width?: number; height?: number; items?: ObsItem[] } }

/** One OBS scene collection file + canvas -> the visible browser sources of a scene, laid out as OBS lays them. */
export function layoutFromObsScene(collection: { sources?: ObsSource[] }, sceneName: string, canvas: [number, number]): OverlayLayout | null {
  const sources = new Map((collection.sources ?? []).map((s) => [s.name, s]));
  const scene = sources.get(sceneName);
  const items = scene?.settings?.items;
  if (!items) return null;
  const layers: OverlayLayer[] = [];
  for (const it of items) {
    const src = sources.get(it.name);
    if (!src || src.id !== 'browser_source' || it.visible === false || !src.settings?.url) continue;
    const pageW = src.settings.width ?? 800, pageH = src.settings.height ?? 600;
    let w = pageW * (it.scale?.x ?? 1), h = pageH * (it.scale?.y ?? 1);
    if (it.bounds_type && it.bounds && it.bounds.x > 0 && it.bounds.y > 0) {
      // scaled to fit inside the bounds, aspect kept (OBS "scale to inner bounds", the common case)
      const k = Math.min(it.bounds.x / pageW, it.bounds.y / pageH);
      w = pageW * k;
      h = pageH * k;
    }
    layers.push({ name: it.name, url: src.settings.url, x: it.pos?.x ?? 0, y: it.pos?.y ?? 0, w, h, pageW, pageH, on: true });
  }
  return layers.length ? { canvas, layers, source: `OBS 场景「${sceneName}」` } : null;
}

/** Reads OBS's files for a scene's overlay layout: the scene collection that holds the scene, the canvas of the current profile. */
export function readObsLayout(sceneName: string, obsDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'obs-studio')): { layout: OverlayLayout | null; detail: string } {
  const scenesDir = join(obsDir, 'basic', 'scenes');
  if (!existsSync(scenesDir)) return { layout: null, detail: '这台电脑上没有 OBS 的场景文件' };
  let canvas: [number, number] = [1920, 1080];
  try {
    const global = readFileSync(join(obsDir, 'global.ini'), 'utf8');
    const profile = /^\s*Profile(?:Dir)?=(.+)$/m.exec(global)?.[1]?.trim();
    const dirs = readdirSync(join(obsDir, 'basic', 'profiles'));
    const dir = dirs.find((d) => d === profile) ?? dirs[0];
    const ini = readFileSync(join(obsDir, 'basic', 'profiles', dir!, 'basic.ini'), 'utf8');
    const cx = Number(/^BaseCX=(\d+)/m.exec(ini)?.[1]), cy = Number(/^BaseCY=(\d+)/m.exec(ini)?.[1]);
    if (cx > 0 && cy > 0) canvas = [cx, cy];
  } catch { /* the default canvas */ }
  for (const file of readdirSync(scenesDir).filter((f) => f.endsWith('.json'))) {
    try {
      const layout = layoutFromObsScene(JSON.parse(readFileSync(join(scenesDir, file), 'utf8')) as { sources?: ObsSource[] }, sceneName, canvas);
      if (layout) return { layout, detail: `${layout.source}:${layout.layers.length} 层，画布 ${canvas[0]}×${canvas[1]}` };
    } catch { /* not a scene collection */ }
  }
  return { layout: null, detail: `OBS 里没有叫「${sceneName}」、带浏览器源的场景` };
}

export function findBrowser(own = ''): string | null {
  const candidates = [
    own,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
  });
}

export type MirrorState = 'off' | 'starting' | 'live' | 'error';

interface Page { layer: number; url: string; session: string; frames: number; latest: string | null; sent: string | null; lastAt: number; error: string | null; retry: NodeJS.Timeout | null }

export interface MirrorOptions {
  /** A changed layer for the game. */
  send: (layer: number, png: string) => void;
  log: () => Logger | undefined;
  fps: () => number;
  maxWidth: () => number;
  browser: () => string;
}

export class OverlayMirror {
  state: MirrorState = 'off';
  detail = '';
  private proc: ChildProcess | null = null;
  private profile = '';
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  private pages: Page[] = [];
  private key = '';
  private timer: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly opts: MirrorOptions) {}

  get layers(): ReadonlyArray<Pick<Page, 'layer' | 'url' | 'frames' | 'latest' | 'lastAt' | 'error'>> {
    return this.pages;
  }

  /** Opens the pages of the layout's layers that are on, or closes everything when not wanted. */
  sync(layout: OverlayLayout | null, wanted: boolean): void {
    const urls = wanted && layout ? layout.layers.map((l) => (l.on ? `${l.url}|${l.pageW}x${l.pageH}` : '')) : [];
    const key = urls.some(Boolean) ? JSON.stringify(urls) : '';
    if (key === this.key) return;
    this.key = key;
    void this.restart(layout, key);
  }

  private async restart(layout: OverlayLayout | null, key: string): Promise<void> {
    await this.starting;
    if (key !== this.key) return;
    await this.stop(false);
    if (!key || !layout) return;
    this.starting = this.open(layout).catch((err: unknown) => {
      this.state = 'error';
      this.detail = (err as Error).message;
      this.opts.log()?.warn('cloudpunk.overlay', `overlay 镜像起不来:${this.detail}`);
      void this.stop(false);
    }).finally(() => { this.starting = null; });
  }

  private async open(layout: OverlayLayout): Promise<void> {
    const exe = findBrowser(this.opts.browser());
    if (!exe) throw new Error('没找到 Edge 或 Chrome');
    this.state = 'starting';
    this.detail = '启动无头浏览器';
    const port = await freePort();
    this.profile = mkdtempSync(join(tmpdir(), 'cloudpunk-overlay-'));
    this.proc = spawn(exe, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check',
      '--mute-audio', '--hide-scrollbars', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--autoplay-policy=no-user-gesture-required', 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    this.proc.once('exit', (code) => {
      if (this.state === 'off') return;
      this.state = 'error';
      this.detail = `浏览器退出了(${code ?? '?'})`;
    });
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) {
      try {
        wsUrl = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '';
      } catch { /* not up yet */ }
      if (!wsUrl) await new Promise((r) => setTimeout(r, 200));
    }
    if (!wsUrl) throw new Error('浏览器的调试端口没起来');
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('连不上浏览器'))); });
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => { if (this.ws === ws && this.state !== 'off') { this.state = 'error'; this.detail = '和浏览器的连接断了'; } });
    for (const [i, l] of layout.layers.entries()) {
      if (!l.on) continue;
      const target = (await this.call('Target.createTarget', { url: 'about:blank' })).targetId as string;
      const session = (await this.call('Target.attachToTarget', { targetId: target, flatten: true })).sessionId as string;
      const page: Page = { layer: i, url: l.url, session, frames: 0, latest: null, sent: null, lastAt: 0, error: null, retry: null };
      this.pages.push(page);
      await this.call('Page.enable', {}, session);
      await this.call('Emulation.setDeviceMetricsOverride', { width: l.pageW, height: l.pageH, deviceScaleFactor: 1, mobile: false }, session);
      // Only one tab of a browser is in front; the others count as hidden and stop producing frames, so a page whose
      // comments arrive after it loaded never sent them (the board, drawn at load, did). Every page is kept active.
      await this.call('Emulation.setFocusEmulationEnabled', { enabled: true }, session);
      await this.call('Page.setWebLifecycleState', { state: 'active' }, session);
      await this.load(page);
    }
    this.state = 'live';
    this.detail = `${this.pages.length} 层`;
    this.timer = setInterval(() => this.flush(), Math.max(50, 1000 / Math.max(1, this.opts.fps())));
    this.opts.log()?.info('cloudpunk.overlay', `overlay 镜像开始:${this.pages.map((p) => p.url).join('、')}`);
  }

  private async load(page: Page): Promise<void> {
    const r = await this.call('Page.navigate', { url: page.url }, page.session);
    if (r.errorText) {
      page.error = `打不开(${String(r.errorText)})`;
      page.retry = setTimeout(() => { page.retry = null; void this.load(page).catch(() => {}); }, 5000);
      return;
    }
    page.error = null;
    await new Promise((res) => setTimeout(res, 800));
    // a page's own background stays transparent, as in an OBS browser source
    await this.call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }, page.session);
    await this.call('Page.startScreencast', { format: 'png', maxWidth: this.opts.maxWidth(), maxHeight: this.opts.maxWidth(), everyNthFrame: 1 }, page.session);
  }

  private call(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('浏览器没连上'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`${method} 没回应`)); }, 10_000);
    });
  }

  private onMessage(text: string): void {
    let m: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { m = JSON.parse(text); } catch { return; }
    if (m.id !== undefined) {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error.message ?? 'CDP error'));
      else w.resolve(m.result ?? {});
      return;
    }
    if (m.method === 'Page.screencastFrame' && m.sessionId) {
      const page = this.pages.find((p) => p.session === m.sessionId);
      void this.call('Page.screencastFrameAck', { sessionId: m.params?.sessionId }, m.sessionId).catch(() => {});
      if (!page) return;
      page.latest = String(m.params?.data ?? '');
      page.frames++;
      page.lastAt = Date.now();
    }
  }

  /** At most `fps` times a second: each layer whose picture changed since it was last sent. */
  private flush(): void {
    for (const p of this.pages) {
      if (!p.latest || p.latest === p.sent) continue;
      p.sent = p.latest;
      this.opts.send(p.layer, p.latest);
    }
  }

  /** Sends every layer's current picture again (the game reconnected). */
  resend(): void {
    for (const p of this.pages) p.sent = null;
  }

  async stop(forget = true): Promise<void> {
    if (forget) this.key = '';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pages) if (p.retry) clearTimeout(p.retry);
    this.pages = [];
    for (const w of this.waiting.values()) w.reject(new Error('镜像停了'));
    this.waiting.clear();
    this.state = 'off';
    this.detail = '';
    try { this.ws?.close(); } catch { /* closing */ }
    this.ws = null;
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null && proc.pid) {
      // Edge starts helper processes; take the whole tree
      await new Promise<void>((resolve) => {
        const k = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.once('exit', () => resolve());
        k.once('error', () => { proc.kill(); resolve(); });
      });
    }
    if (this.profile) {
      const dir = this.profile;
      this.profile = '';
      setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked */ } }, 2000);
    }
  }
}
