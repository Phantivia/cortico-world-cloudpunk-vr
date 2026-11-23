/**
 * 云朋克 World:操作员戴 VR 头显玩 Cloudpunk 直播，可缇照常用 vtuber World 说话，同时接在游戏的通讯频道上。
 *
 * 游戏里的 CloudpunkVR 插件负责身体：读任务、对话、地图，在交通航线上规划路线并能代开，把 VTube Studio 的 Spout
 * 画面放进 NPC 的通讯框(驾驶舱通讯屏、界面左下角、左手腕)，把直播间那层 overlay 搬进头显，给 OBS 的平稳画面。
 * 这里把插件的事实写成短中文交给模型，把可缇的台词(vtuber World 的演出流)接进通讯框，用无头浏览器把 OBS 叠在
 * 游戏上的 overlay 页面原样渲染给游戏，并给 WebUI 的开播、可缇画面、直播 overlay、游戏四个页签供数。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputTap, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { DeepPartial } from 'cortico/world.ts';
import { nowIso } from 'cortico/core/util.ts';
import { GameBridge, PROTOCOL, type GameFrame, type GameState } from './bridge.ts';
import { CLOUDPUNK_CONFIG_GROUPS, type CloudpunkConfigSection } from './config.ts';
import { detectOverlays, probeOverlay, SseFeed, type FeedState } from './feeds.ts';
import { OverlayMirror, parseLayout, readObsLayout, stackedLayout, type OverlayLayout } from './mirror.ts';
import { placesText, renderEvent, statusText, TAG, type PlacesResult } from './render.ts';
import { CueScheduler, type Line } from './stage.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const REQUEST_TIMEOUT_MS = 8000;
const NOT_CONNECTED = '没执行：游戏没连上(游戏没开、没装 CloudpunkVR,或 [Coo] Enabled 关着)。';

export const CLOUDPUNK_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'cloudpunk_status',
    description: 'What the game shows right now: where the player is, car speed and fuel, credits, the quest list with how far each map marker is, the dialogue line on screen, what can be interacted with, and the navigation state. see: true also attaches the current picture (the stream view).',
    tags: ['read'],
    parameters: { type: 'object', additionalProperties: false, properties: { see: { type: 'boolean' } } },
  },
  {
    name: 'cloudpunk_places',
    description: 'Search the places the game map knows: shops, vendors, gas stations, garages, parking, named places on the full map, quest markers. query: a name or a kind ("加油站", "最近的商店"); empty lists the nearest. Each result has an id for cloudpunk_navigate, its kind, distance, height difference and direction from where the operator faces; also the kinds of places there are.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30 } },
    },
  },
  {
    name: 'cloudpunk_navigate',
    description: 'Plan a route and draw it on the minimap and the full map. Target: quest (an id from the quest list; default the nearest quest with a marker), or place: parking (nearest parking spot) | car (walk back to the car) | an id from cloudpunk_places | a place name or kind (the nearest best match). In the car the route follows the city traffic lanes to the parking spot nearest the target. A quest on another level goes to the lift the game\'s own quest marker points at; once through the lift the route to the quest is planned again from the new level. While the operator drives a shown route, it is planned again when they leave it, and events give each turn, climb or descent ahead and the destination coming up, in time to say them. drive: true also drives it (or walks it, on foot) through the game\'s own controls and parks at the end; false only shows the way. Any stick or trigger the operator touches takes the car back and the route stays on the map. Events tell when it arrives or stops.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        quest: { type: 'string' },
        place: { type: 'string' },
        drive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'cloudpunk_stop',
    description: 'Stop driving or walking and clear the route from the map.',
    tags: ['act'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

function gameRunning(exe: string): Promise<boolean> {
  const name = basename(exe);
  if (!name || process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => resolve(!err && stdout.toLowerCase().includes(`"${name.toLowerCase()}"`)));
  });
}

export interface CloudpunkWorldOptions {
  cfg: CloudpunkConfigSection;
  timezone: string;
  /** Writes config back to config.json (the overlay addresses found by themselves). */
  persist?: (patch: DeepPartial<CloudpunkConfigSection>) => void;
  /** Tests: where to look for the overlays when an address is empty. */
  detect?: () => Promise<Partial<Record<'vtuber' | 'bilibili' | 'asr', string>>>;
  /** Tests: the OBS layout lookup and the mirror. */
  obsLayout?: (scene: string) => { layout: OverlayLayout | null; detail: string };
  mirror?: OverlayMirror;
  bridge?: GameBridge;
}

interface FeedView { state: FeedState; detail: string; received: number; lastAt: number }

export class CloudpunkWorld implements World {
  readonly id = 'cloudpunk';
  readonly bridge: GameBridge;
  private host: WorldHost | null = null;
  private lamp: 'offline' | 'loading' | 'online' | 'error' = 'offline';
  private detail = '';
  state: GameState | null = null;
  /** 开播中：通讯框、头显里的 overlay、台词流都只在开播后才有。重启 bot 后要再点一次开始。 */
  onAir = false;
  private configSent = '';
  private outputText = '';
  private ticker: NodeJS.Timeout | null = null;
  readonly cues: CueScheduler;
  readonly subtitleFeed: SseFeed;
  readonly mirror: OverlayMirror;
  /** 头显里那层 overlay 的布局：配置里写死的，或按 OBS 场景读的，或本机找到的铺满。 */
  layout: OverlayLayout | null = null;
  layoutDetail = '';
  private layoutKey = '';

  constructor(private readonly opts: CloudpunkWorldOptions) {
    this.bridge = opts.bridge ?? new GameBridge();
    this.bridge.on('hello', (f: GameFrame) => void this.onHello(f));
    this.bridge.on('event', (f: GameFrame) => void this.onEvent(f));
    this.bridge.on('state', (s: GameState) => this.onState(s));
    this.bridge.on('disconnect', () => {
      this.lamp = 'loading';
      this.detail = '等待游戏';
      this.configSent = '';
      this.syncFeeds();
      void this.push('connection', `${TAG} 游戏连接断开，插件可连时自动重连。`, 'flush', true);
    });
    const log = () => this.host?.log;
    this.cues = new CueScheduler((line) => this.sayLine(line));
    this.subtitleFeed = new SseFeed('subtitle', (m) => this.cues.onMessage(m), log);
    this.mirror = opts.mirror ?? new OverlayMirror({
      send: (layer, png) => this.bridge.notify({ type: 'overlay_frame', layer, png }),
      log,
      fps: () => this.cfg.overlay.fps,
      maxWidth: () => this.cfg.overlay.maxWidth,
      browser: () => this.cfg.overlay.browser,
    });
  }

  private get cfg(): CloudpunkConfigSection {
    return this.opts.cfg;
  }

  envPromptVars(): Record<string, string> {
    return { 'cloudpunk.live': this.onAir ? '正在直播，你接在通讯频道上' : '还没开播，通讯频道上没有你' };
  }

  tools(): ToolDef[] {
    const [status, places, navigate, stop] = CLOUDPUNK_TOOL_DECLS;
    return [
      { ...status, handler: (a) => this.status(a as { see?: boolean }) },
      { ...places, handler: (a) => this.places(a as { query?: string; limit?: number }) },
      { ...navigate, handler: (a) => this.navigate(a as { quest?: string; place?: string; drive?: boolean }) },
      { ...stop, handler: () => this.simple('stop', {}, () => '停下了，路线已从地图上清掉。') },
    ];
  }

  /** 没接台词来源时，通讯框显示模型输出的文字。 */
  outputTap(): OutputTap | undefined {
    if (this.cfg.corti.subtitleUrl.trim() || !this.onAir || !this.bridge.connected) return undefined;
    return {
      onEvent: (event) => {
        const e = event as { type?: string; delta?: string };
        if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') this.outputText += e.delta;
      },
      externalizes: () => false,
      onRoundEnd: () => {
        const text = this.outputText.trim();
        this.outputText = '';
        if (text) this.bridge.notify({ type: 'corti_line', text: text.slice(0, 160), seconds: Math.min(12, Math.max(1.5, text.length * 0.22)) });
      },
      onAbort: () => { this.outputText = ''; },
    };
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [
        { label: '游戏插件', state: this.lamp, hint: this.detail || undefined },
        { label: '开播', state: this.onAir ? 'online' : 'offline', hint: this.onAir ? '通讯框和 overlay 在游戏里' : '在开播页点开始' },
      ],
      badges: [
        { label: '状态', value: this.state ? `${this.state.mode}${this.state.sector ? ' · ' + this.state.sector : ''}` : '—' },
        { label: '导航', value: this.state?.autopilot && this.state.autopilot.phase !== 'off' ? `${this.state.autopilot.phase} ${this.state.autopilot.remainingM ?? ''}m` : '—' },
      ],
      panels: [
        { id: 'live', title: '开播', description: '一键开始：启动游戏、把可缇接上通讯频道、把直播 overlay 搬进头显;各条接线的状态。' },
        { id: 'corti', title: '可缇画面', description: 'VTube Studio 的 Spout 画面在通讯框里的取景、显示位置和台词来源。' },
        { id: 'overlay', title: '直播 overlay', description: 'OBS 叠在游戏上的那层 overlay 搬进头显：有哪几层、摆在眼前哪里。' },
        { id: 'game', title: '游戏', description: '游戏程序、启动方式和游戏现状。' },
      ],
      config: CLOUDPUNK_CONFIG_GROUPS,
      invoke: async (_panel, method, args) => this.invoke(method, args),
      promptDocs: [{
        key: 'worlds.cloudpunk.envPrompt', title: '云朋克 · 环境提示词', description: '直播场景、通讯频道、身体能做什么。', path: ENV_PROMPT_FILE, role: 'envPrompt',
        vars: [{ name: 'cloudpunk.live', description: '开没开播' }],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.lamp = 'loading';
    this.detail = '等待游戏';
    this.bridge.open(this.cfg.port);
    void this.fillAddresses().then(() => this.resolveLayout(false));
    // 配置页、面板改的值热生效：每秒对一次布局、要发给插件的配置和要开的流
    this.ticker = setInterval(() => {
      void this.resolveLayout(false);
      this.syncConfig(false);
      this.syncFeeds();
    }, 1000);
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.onAir = false;
    this.cues.clear();
    this.subtitleFeed.stop();
    await this.mirror.stop();
    this.bridge.close();
    this.host = null;
    this.lamp = 'offline';
  }

  // ---- 操作员(WebUI) -------------------------------------------------------------------

  async invoke(method: string, args: unknown[] = []): Promise<unknown> {
    switch (method) {
      case 'state': return this.panelState();
      case 'start': return { text: await this.goLive() };
      case 'stop': return { text: this.offAir() };
      case 'launch': return { text: await this.launch() };
      case 'detect': return detectOverlays();
      case 'probe': return probeOverlay(String(args[0] ?? ''));
      case 'preview': {
        const r = await this.call('preview', { width: Number(args[0] ?? 480) }, 8000);
        if ('text' in r) return { live: false, problem: r.text.replace(/^没执行：/, '') };
        return r.result;
      }
      case 'testLine': {
        const text = String(args[0] ?? '') || '这是一句试显台词，看看通讯框里是什么样子。';
        this.cues.schedule([{ atMs: 0, line: { text, seconds: Math.max(1.5, text.length * 0.2) } }]);
        return { text: this.onAir ? '发了一句试显台词' : '发了，但还没开播：开始以后通讯框才出现' };
      }
      case 'overlay': return this.overlayView(args[0] === true);
      case 'importObs': {
        const r = (this.opts.obsLayout ?? readObsLayout)(this.cfg.overlay.obsScene);
        if (!r.layout) return { text: r.detail, failed: true };
        this.cfg.overlay.layout = JSON.stringify(r.layout);
        this.opts.persist?.({ overlay: { layout: this.cfg.overlay.layout } });
        await this.resolveLayout(true);
        return { text: `照 ${r.detail} 摆好了` };
      }
      case 'autoLayout': {
        this.cfg.overlay.layout = '';
        this.opts.persist?.({ overlay: { layout: '' } });
        await this.resolveLayout(true);
        return { text: this.layoutDetail || '没找到 overlay' };
      }
      case 'setLayer': {
        const i = Number(args[0]);
        const on = args[1] === true;
        if (!this.layout || !this.layout.layers[i]) throw new Error('没有这一层');
        this.layout.layers[i]!.on = on;
        this.cfg.overlay.layout = JSON.stringify(this.layout);
        this.opts.persist?.({ overlay: { layout: this.cfg.overlay.layout } });
        await this.resolveLayout(true);
        return { text: `${this.layout.layers[i]!.name} ${on ? '显示' : '不显示'}` };
      }
      case 'reloadOverlay': {
        await this.mirror.stop();
        this.syncFeeds();
        return { text: '重新打开了 overlay 页面' };
      }
      default: throw new Error(`未知方法 ${method}`);
    }
  }

  private feedView(f: SseFeed): FeedView {
    return { state: f.state, detail: f.detail, received: f.received, lastAt: f.lastAt };
  }

  private async panelState(): Promise<Record<string, unknown>> {
    const exe = this.cfg.gameExe;
    let live: unknown = null;
    if (this.bridge.connected) {
      const r = await this.call('live', {}, 3000);
      if (!('text' in r)) live = r.result;
    }
    return {
      exe, exists: !!exe && existsSync(exe), running: await gameRunning(exe), connected: this.bridge.connected,
      vr: !!this.bridge.hello?.vr, lamp: this.lamp, detail: this.detail, onAir: this.onAir,
      game: this.state ? { mode: this.state.mode, sector: this.state.sector ?? null, text: statusText(this.state) } : null,
      live,
      feeds: { subtitle: this.feedView(this.subtitleFeed) },
      overlay: { state: this.mirror.state, detail: this.mirror.detail, layout: this.layoutDetail, layers: this.layout?.layers.length ?? 0, live: this.mirror.layers.filter((l) => l.frames > 0).length },
      lastLine: this.cues.last,
      cfg: this.cfg,
    };
  }

  /**
   * An empty subtitle address is looked up on this PC (the vtuber World serves its overlay on a local port) and written
   * back to the config. An address already filled in is left alone.
   */
  async fillAddresses(): Promise<string[]> {
    const c = this.cfg;
    if (c.corti.subtitleUrl.trim()) return [];
    let found: Partial<Record<'vtuber' | 'bilibili' | 'asr', string>>;
    try {
      found = await (this.opts.detect ?? detectOverlays)();
    } catch {
      return [];
    }
    if (!found.vtuber) return [];
    c.corti.subtitleUrl = found.vtuber;
    this.opts.persist?.({ corti: { subtitleUrl: c.corti.subtitleUrl } });
    this.host?.log.info('cloudpunk.overlay', `自动填上了台词来源 ${found.vtuber}`);
    this.syncFeeds();
    return [`台词 ${found.vtuber}`];
  }

  /**
   * The overlay layout for the headset: the one in the config; else the OBS scene's browser sources as OBS lays them;
   * else the overlays found on this PC laid full size. Worked out again when the config's layout or scene changes.
   */
  async resolveLayout(force: boolean): Promise<void> {
    const key = `${this.cfg.overlay.layout}|${this.cfg.overlay.obsScene}`;
    if (!force && key === this.layoutKey) return;
    this.layoutKey = key;
    const own = parseLayout(this.cfg.overlay.layout);
    if (own) {
      this.layout = own;
      this.layoutDetail = `${own.source || '配置里的布局'}:${own.layers.length} 层`;
    } else {
      const obs = (this.opts.obsLayout ?? readObsLayout)(this.cfg.overlay.obsScene);
      if (obs.layout) {
        this.layout = obs.layout;
        this.layoutDetail = obs.detail;
      } else {
        let found: Partial<Record<'vtuber' | 'bilibili' | 'asr', string>> = {};
        try { found = await (this.opts.detect ?? detectOverlays)(); } catch { /* none */ }
        const names: Record<string, string> = { vtuber: '可缇演出层', bilibili: '直播间', asr: '语音字幕' };
        const urls = (['vtuber', 'bilibili', 'asr'] as const).filter((k) => found[k]).map((k) => ({ name: names[k]!, url: found[k]! }));
        this.layout = urls.length ? stackedLayout(urls) : null;
        this.layoutDetail = urls.length ? `${obs.detail};改用本机找到的 ${urls.length} 个 overlay 铺满` : `${obs.detail};本机也没找到 overlay`;
      }
    }
    this.syncConfig(true);
    this.syncFeeds();
  }

  /** The overlay tab: the layout, each layer's state and (with pictures) its latest frame. */
  private overlayView(pictures: boolean): Record<string, unknown> {
    const pages = this.mirror.layers;
    return {
      state: this.mirror.state, detail: this.mirror.detail, layoutDetail: this.layoutDetail, onAir: this.onAir,
      connected: this.bridge.connected, vr: !!this.bridge.hello?.vr,
      canvas: this.layout?.canvas ?? [1920, 1080],
      layers: (this.layout?.layers ?? []).map((l, i) => {
        const p = pages.find((x) => x.layer === i);
        return { ...l, frames: p?.frames ?? 0, lastAt: p?.lastAt ?? 0, error: p?.error ?? null, ...(pictures && p?.latest ? { png: p.latest } : {}) };
      }),
      cfg: this.cfg.overlay,
    };
  }

  private async goLive(): Promise<string> {
    const said: string[] = [];
    const filled = await this.fillAddresses();
    if (filled.length) said.push(`自动找到 ${filled.join(';')}`);
    if (!this.bridge.connected && !(await gameRunning(this.cfg.gameExe))) {
      try {
        said.push(await this.launch());
      } catch (err) {
        said.push(`游戏没启动：${(err as Error).message}`);
      }
    }
    this.onAir = true;
    this.syncConfig(true);
    this.syncFeeds();
    said.push(this.bridge.connected ? '可缇接上了通讯频道，overlay 搬进了头显' : '开播了，游戏连上后通讯框和 overlay 自动出现');
    void this.push('live', `${TAG} 开播：你接在操作员的通讯频道上了。`, 'piggyback', true);
    return said.join(';');
  }

  private offAir(): string {
    this.onAir = false;
    this.cues.clear();
    this.syncConfig(true);
    this.syncFeeds();
    this.bridge.notify({ type: 'corti_cut' });
    void this.push('live', `${TAG} 收工：通讯频道关了。`, 'piggyback', true);
    return '收工了：通讯框和 overlay 撤下，游戏还开着';
  }

  private async launch(): Promise<string> {
    const exe = this.cfg.gameExe;
    if (!exe || !existsSync(exe)) throw new Error(`找不到游戏程序 ${exe}`);
    if (await gameRunning(exe)) return '游戏已经开着';
    const args = this.cfg.launchVr ? ['-vrmode', 'OpenVR'] : [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, args, { cwd: dirname(exe), detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return `游戏启动了${this.cfg.launchVr ? '(VR)' : ''},插件连上后自动接线(Steam 要开着)`;
  }

  // ---- 游戏 -> 模型 -------------------------------------------------------------------

  private async onHello(f: GameFrame): Promise<void> {
    if (f.protocol !== PROTOCOL) {
      this.lamp = 'error';
      this.detail = `插件协议 ${String(f.protocol)},World 要 ${PROTOCOL}:更新 CloudpunkVR`;
      return;
    }
    this.lamp = 'online';
    this.detail = f.vr ? '已连接(VR)' : '已连接';
    this.syncConfig(true);
    this.mirror.resend();
    this.syncFeeds();
    await this.push('connection', `${TAG} 游戏连上了${f.vr ? '(操作员戴着头显)' : ''}。`, 'piggyback', true);
  }

  onState(s: GameState): void {
    this.state = s;
  }

  /** 要发给插件的配置：变了才发(配置页、面板改，刚连上，开播收工)。 */
  configMessage(): Record<string, unknown> {
    const c = this.cfg;
    const vr = !!this.bridge.hello?.vr;
    return {
      type: 'config',
      onAir: this.onAir,
      view: vr && c.streamView ? 'spectator' : 'off',
      autopilotSpeed: c.autopilotSpeed,
      corti: {
        name: c.corti.name, sender: c.corti.sender, zoom: c.corti.zoom, x: c.corti.x, y: c.corti.y, flip: c.corti.flip,
        holo: c.corti.holo, car: c.corti.inCar, foot: c.corti.onFoot, wrist: c.corti.onWrist,
        popOut: c.corti.popOut, popZoom: c.corti.popZoom, popSize: c.corti.popSize, fufu: c.corti.fufu,
      },
      overlay: {
        on: c.overlay.on, yaw: c.overlay.yaw, pitch: c.overlay.pitch, distance: c.overlay.distance, width: c.overlay.width, opacity: c.overlay.opacity,
        canvas: this.layout?.canvas ?? [1920, 1080],
        layers: (this.layout?.layers ?? []).map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h, on: l.on })),
      },
    };
  }

  private syncConfig(force: boolean): void {
    if (!this.bridge.connected) return;
    const msg = this.configMessage();
    const key = JSON.stringify(msg);
    if (!force && key === this.configSent) return;
    this.configSent = key;
    this.bridge.notify(msg);
  }

  /**
   * The subtitle stream and the overlay mirror run only on air with the game connected (the vtuber World takes a
   * subscriber on its stage stream for being on air); the mirror only for a headset, the only place it shows.
   */
  private syncFeeds(): void {
    const on = this.onAir && this.bridge.connected;
    this.subtitleFeed.sync(this.cfg.corti.subtitleUrl, on);
    this.mirror.sync(this.layout, on && this.cfg.overlay.on && !!this.bridge.hello?.vr);
    if (!on) this.cues.clear();
  }

  private async onEvent(f: GameFrame): Promise<void> {
    if (f.name === 'maneuver' && !this.cfg.navPrompts) return;
    const r = renderEvent(f);
    if (!r) return;
    await this.push(r.noun, r.text, r.trigger);
  }

  private async push(noun: string, text: string, trigger: 'preempt' | 'interrupt' | 'flush' | 'debounce' | 'piggyback', internal = false): Promise<void> {
    try {
      await this.host?.pushEvent({ type: `cloudpunk.${noun}`, source: this.id, senderKey: this.id, ts: nowIso(this.opts.timezone), text, ...(internal ? { origin: 'internal' as const } : {}) }, { trigger });
    } catch (err) {
      this.host?.log.warn('cloudpunk.event', String(err));
    }
  }

  // ---- 台词 -> 游戏 ---------------------------------------------------------------------

  private sayLine(line: Line | null): void {
    if (!line) this.bridge.notify({ type: 'corti_cut' });
    else this.bridge.notify({ type: 'corti_line', text: line.text, seconds: line.seconds });
  }

  // ---- 工具 ---------------------------------------------------------------------------

  private async call(method: string, args: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ ok: true; result: unknown } | ToolOutcome> {
    if (!this.bridge.connected) return { text: NOT_CONNECTED, failed: true };
    try {
      const rep = await this.bridge.request(method, args, timeoutMs);
      if (!rep.ok) return { text: `没执行：${String(rep.error)}`, failed: true };
      return { ok: true, result: rep.result };
    } catch (err) {
      return { text: `没执行：${(err as Error).message}`, failed: true };
    }
  }

  private async simple(method: string, args: Record<string, unknown>, ok: (result: unknown) => string): Promise<string | ToolOutcome> {
    const r = await this.call(method, args);
    if ('text' in r) return r;
    return ok(r.result);
  }

  private async status(a: { see?: boolean }): Promise<string | ToolOutcome> {
    const r = await this.call('state', {});
    if ('text' in r) return r;
    const text = statusText(r.result as GameState);
    if (!a.see) return text;
    if (this.host && !this.host.modelFacts.accepts('image/jpeg')) return `${text}\n(当前模型不收图片，没附画面)`;
    const shot = await this.call('snapshot', { width: 960 }, 12000);
    if ('text' in shot) return `${text}\n(画面没拿到:${shot.text})`;
    const img = shot.result as { data: string; width: number; height: number };
    return { text, blobs: [{ bytes: Buffer.from(img.data, 'base64'), mime: 'image/jpeg', name: 'cloudpunk.jpg', fallbackText: `游戏画面 ${img.width}×${img.height}` }] };
  }

  private async places(a: { query?: string; limit?: number }): Promise<string | ToolOutcome> {
    const r = await this.call('places', { query: a.query ?? '', limit: a.limit ?? 8 });
    if ('text' in r) return r;
    return placesText(r.result as PlacesResult, a.query ?? '');
  }

  private async navigate(a: { quest?: string; place?: string; drive?: boolean }): Promise<string | ToolOutcome> {
    const args: Record<string, unknown> = {};
    if (a.quest) args.quest = a.quest;
    if (a.place) args.place = a.place;
    args.drive = a.drive === true;
    const r = await this.call('navigate', args, 15000);
    if ('text' in r) return r;
    const res = r.result as { target: string; routeM: number; straightM: number; phase: string; parking?: unknown; viaLift?: boolean };
    const how = res.phase === 'drive' ? '开始自动驾驶' : res.phase === 'walk' ? '开始走过去' : '路线画在地图上了';
    return `${how}:去「${res.target}」,路线约 ${res.routeM} 米(直线 ${res.straightM} 米)${res.parking ? ',终点是旁边的停车位' : ''}${res.viaLift ? '。任务在另一层，路线先到游戏标记的升降梯，进梯换层后会接着规划' : ''}。`;
  }
}
