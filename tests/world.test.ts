import { createServer as createHttp, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CLOUDPUNK_DEFAULTS, type CloudpunkConfigSection } from '../src/config.ts';
import { overlayKindOf, streamUrlOf } from '../src/feeds.ts';
import { layoutFromObsScene, OverlayMirror, parseLayout, type OverlayLayout } from '../src/mirror.ts';
import { linesOf } from '../src/stage.ts';
import { CloudpunkWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

/** The game side of docs/protocol.md: one JSON object per line over TCP, like the CloudpunkVR plugin. */
class FakePlugin {
  server: Server;
  sock: Socket | null = null;
  got: Array<Record<string, unknown>> = [];
  replies: Record<string, (args: Record<string, unknown>) => { ok: boolean; result?: unknown; error?: string }> = {};
  port = 0;

  constructor(private readonly vr = false) {
    this.server = createServer((s) => {
      this.sock = s;
      s.setEncoding('utf8');
      let buf = '';
      s.on('data', (d: string) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
          const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
          buf = buf.slice(i + 1);
          this.got.push(m);
          if (m.type === 'request') {
            const r = this.replies[String(m.method)]?.(m.args as Record<string, unknown>) ?? { ok: true, result: {} };
            this.send({ type: 'reply', id: m.id, ...r });
          }
        }
      });
      this.send({ type: 'hello', protocol: 2, game: 'cloudpunk', vr: this.vr, plugin: 'test' });
    });
  }
  listen(): Promise<number> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as AddressInfo).port; r(this.port); }));
  }
  send(m: Record<string, unknown>): void {
    this.sock?.write(`${JSON.stringify(m)}\n`);
  }
  lastConfig(): Record<string, unknown> | undefined {
    return this.got.filter((m) => m.type === 'config').at(-1);
  }
  close(): void {
    this.sock?.destroy();
    this.server.close();
  }
}

/** An overlay World's /stream: counts subscribers, sends what the test pushes. */
class FakeOverlay {
  server: HttpServer;
  subs: ServerResponse[] = [];
  opened = 0;
  constructor() {
    this.server = createHttp((req, res) => {
      if (req.url !== '/stream') { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', recent: ['旧的一句'] })}\n\n`);
      this.opened++;
      this.subs.push(res);
      res.on('close', () => { this.subs = this.subs.filter((s) => s !== res); });
    });
  }
  listen(): Promise<string> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}/overlay`)));
  }
  send(m: Record<string, unknown>): void {
    for (const s of this.subs) s.write(`data: ${JSON.stringify(m)}\n\n`);
  }
  close(): void {
    for (const s of this.subs) s.destroy();
    this.server.close();
  }
}

/** The mirror without a browser: remembers what it was asked to show. */
class FakeMirror extends OverlayMirror {
  calls: Array<{ layers: number; wanted: boolean }> = [];
  constructor() { super({ send: () => {}, log: () => undefined, fps: () => 8, maxWidth: () => 1280, browser: () => '' }); }
  override sync(layout: OverlayLayout | null, wanted: boolean): void { this.calls.push({ layers: layout?.layers.length ?? 0, wanted }); }
  override async stop(): Promise<void> {}
  get wanted(): boolean { return this.calls.at(-1)?.wanted ?? false; }
}

/** An OBS scene collection like the stream's: the game capture, two browser sources, one hidden. */
const OBS_COLLECTION = {
  sources: [
    { name: '云朋克直播间', id: 'scene', settings: { items: [
      { name: '游戏', visible: true, pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 } },
      { name: 'Corti Overlay', visible: true, pos: { x: -89, y: 0 }, scale: { x: 0.926, y: 0.926 }, bounds_type: 2, bounds: { x: 1778, y: 1000 } },
      { name: 'Stream Overlay', visible: true, pos: { x: 0, y: 0 }, scale: { x: 0.926, y: 0.926 } },
      { name: '旧弹幕', visible: false, pos: { x: 0, y: 0 } },
    ] } },
    { name: '游戏', id: 'game_capture', settings: {} },
    { name: 'Corti Overlay', id: 'browser_source', settings: { url: 'http://127.0.0.1:7792/overlay', width: 1920, height: 1080 } },
    { name: 'Stream Overlay', id: 'browser_source', settings: { url: 'http://127.0.0.1:7795/overlay', width: 1728, height: 1080 } },
    { name: '旧弹幕', id: 'browser_source', settings: { url: 'http://127.0.0.1:9000/', width: 800, height: 600 } },
  ],
};
const obsScene = () => ({ layout: layoutFromObsScene(OBS_COLLECTION, '云朋克直播间', [1600, 1000]), detail: 'OBS 场景「云朋克直播间」:2 层' });
const noObs = () => ({ layout: null, detail: 'OBS 里没有这个场景' });

/** the pushed event of one type, with the trigger it was pushed with */
const pushed = (host: FakeHost, type: string) => {
  const i = host.events.findIndex((e) => e.type === type);
  return i < 0 ? null : { event: host.events[i], opts: host.pushOpts[i] };
};

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function config(port: number, edit: (c: CloudpunkConfigSection) => void = () => {}): CloudpunkConfigSection {
  const c = structuredClone(CLOUDPUNK_DEFAULTS);
  c.port = port;
  c.gameExe = 'Z:\\nowhere\\Cloudpunk.exe';
  c.corti.subtitleUrl = '';
  edit(c);
  return c;
}

interface SetupOpts { vr?: boolean; detect?: () => Promise<Record<string, string>>; obs?: (scene: string) => { layout: OverlayLayout | null; detail: string } }

async function setup(edit: (c: CloudpunkConfigSection) => void = () => {}, o: SetupOpts = {}) {
  const vr = o.vr ?? false;
  const detect = o.detect ?? (async () => ({}));
  const mirror = new FakeMirror();
  const plugin = new FakePlugin(vr);
  const port = await plugin.listen();
  const cfg = config(port, edit);
  const host = new FakeHost();
  const persisted: unknown[] = [];
  const world = new CloudpunkWorld({ cfg, timezone: 'UTC', detect, obsLayout: o.obs ?? noObs, mirror, persist: (p) => persisted.push(p) });
  await world.start(host);
  cleanup.push(() => { void world.stop(); plugin.close(); });
  await until(() => world.bridge.connected);
  const tool = (name: string) => {
    const t = world.tools().find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return (args: Record<string, unknown> = {}) => t.handler(args, {} as never);
  };
  return { plugin, host, world, cfg, tool, persisted, mirror };
}

const clearEvents = (host: FakeHost) => { host.events.length = 0; host.pushOpts.length = 0; };

describe('going on air', () => {
  it('the plugin hears off air until the start button, then the call box and the overlay laid out as OBS lays it', async () => {
    const { plugin, world } = await setup((c) => { c.corti.zoom = 2.2; c.overlay.distance = 1.2; }, { obs: obsScene });
    await until(() => !!plugin.lastConfig());
    expect(plugin.lastConfig()).toMatchObject({ onAir: false });
    await world.invoke('start');
    await until(() => plugin.lastConfig()?.onAir === true);
    await until(() => (plugin.lastConfig()?.overlay as { layers: unknown[] }).layers.length === 2);
    expect(plugin.lastConfig()).toMatchObject({
      corti: { zoom: 2.2, name: '可缇', holo: true },
      overlay: { on: true, distance: 1.2, canvas: [1600, 1000], layers: [{ x: -89, y: 0, on: true }, { x: 0, y: 0, on: true }] },
    });
  });

  it('a headset gets the steadied stream view unless it is switched off', async () => {
    const vr = await setup(() => {}, { vr: true });
    await until(() => !!vr.plugin.lastConfig());
    expect(vr.plugin.lastConfig()).toMatchObject({ view: 'spectator' });
    const off = await setup((c) => { c.streamView = false; }, { vr: true });
    await until(() => !!off.plugin.lastConfig());
    expect(off.plugin.lastConfig()).toMatchObject({ view: 'off' });
  });

  it('a value changed on a page reaches the plugin without a restart', async () => {
    const { plugin, world, cfg } = await setup();
    await world.invoke('start');
    cfg.overlay.pitch = -20;
    await until(() => (plugin.lastConfig()?.overlay as { pitch: number } | undefined)?.pitch === -20);
  });
});

describe('subtitle address', () => {
  it('an empty one is found on this PC and written back; a filled one is left alone', async () => {
    const found = { vtuber: 'http://127.0.0.1:7792/overlay' };
    const empty = await setup(() => {}, { detect: async () => found });
    await until(() => empty.persisted.length > 0);
    expect(empty.cfg.corti.subtitleUrl).toBe(found.vtuber);
    expect(empty.persisted[0]).toEqual({ corti: { subtitleUrl: found.vtuber } });
    const filled = await setup((c) => { c.corti.subtitleUrl = 'http://127.0.0.1:9999/overlay'; }, { detect: async () => found });
    await new Promise((r) => setTimeout(r, 200));
    expect(filled.cfg.corti.subtitleUrl).toBe('http://127.0.0.1:9999/overlay');
  });
});

describe('overlay layout', () => {
  it('the layout in the config wins, then the OBS scene, then the overlays found here laid full size', async () => {
    let obs: { layout: OverlayLayout | null; detail: string } = noObs();
    const found = { vtuber: 'http://127.0.0.1:7792/overlay', bilibili: 'http://127.0.0.1:7795/overlay' };
    const { world, cfg } = await setup(() => {}, { detect: async () => found, obs: () => obs });
    await until(() => world.layout !== null);
    expect(world.layout!.layers.map((l) => [l.name, l.x, l.w])).toEqual([['可缇演出层', 0, 1920], ['直播间', 0, 1920]]);
    obs = obsScene();
    await world.invoke('autoLayout');
    expect(world.layout!.source).toBe('OBS 场景「云朋克直播间」');
    cfg.overlay.layout = JSON.stringify({ canvas: [1280, 720], layers: [{ name: '自己的', url: 'http://127.0.0.1:8000/' }] });
    await until(() => world.layout?.canvas[0] === 1280);
    expect(world.layout!.layers).toHaveLength(1);
  });

  it('a layer switched off on the panel is off for the plugin and kept in the config', async () => {
    const { plugin, world, cfg, persisted } = await setup(() => {}, { obs: obsScene });
    await until(() => (plugin.lastConfig()?.overlay as { layers: unknown[] } | undefined)?.layers.length === 2);
    await world.invoke('setLayer', [1, false]);
    await until(() => (plugin.lastConfig()?.overlay as { layers: Array<{ on: boolean }> }).layers[1]!.on === false);
    expect(parseLayout(cfg.overlay.layout)!.layers.map((l) => l.on)).toEqual([true, false]);
    expect(persisted.at(-1)).toEqual({ overlay: { layout: cfg.overlay.layout } });
  });
});

describe('overlay mirror', () => {
  it('runs only on air, with a headset connected and the overlay switched on', async () => {
    const flat = await setup(() => {}, { obs: obsScene });
    await flat.world.invoke('start');
    expect(flat.mirror.calls.some((c) => c.wanted)).toBe(false);

    const vr = await setup(() => {}, { vr: true, obs: obsScene });
    await until(() => vr.world.layout !== null);
    expect(vr.mirror.calls.some((c) => c.wanted)).toBe(false);
    await vr.world.invoke('start');
    expect(vr.mirror.calls.at(-1)).toEqual({ layers: 2, wanted: true });
    vr.cfg.overlay.on = false;
    await until(() => !vr.mirror.wanted);
    vr.cfg.overlay.on = true;
    await until(() => vr.mirror.wanted);
    await vr.world.invoke('stop');
    expect(vr.mirror.wanted).toBe(false);
  });
});

describe('subtitle stream', () => {
  it('is only subscribed while on air; 可缇 lines reach the plugin', async () => {
    const vt = new FakeOverlay();
    const v = await vt.listen();
    cleanup.push(() => vt.close());
    const { plugin, world } = await setup((c) => { c.corti.subtitleUrl = v; });
    await new Promise((r) => setTimeout(r, 1200));
    // the vtuber World counts a subscriber on its stage stream as being on air: nobody may listen before the start
    expect(vt.opened).toBe(0);
    await world.invoke('start');
    await until(() => vt.subs.length === 1);
    vt.send({ type: 'subtitle', cues: [{ text: '好呀', atMs: 0, speakMs: 800 }] });
    await until(() => plugin.got.some((m) => m.type === 'corti_line'));
    expect(plugin.got.find((m) => m.type === 'corti_line')).toEqual({ type: 'corti_line', text: '好呀', seconds: 0.8 });
    await world.invoke('stop');
    await until(() => vt.subs.length === 0);
  });
});

describe('game events', () => {
  it('an NPC taking the channel while 可缇 speaks interrupts her, while silent wakes her; freeing it rides along', async () => {
    const { plugin, host } = await setup();
    plugin.send({ type: 'event', name: 'channel', busy: true, speaker: '调度', speaking: true });
    await until(() => !!pushed(host, 'cloudpunk.channel'));
    expect(pushed(host, 'cloudpunk.channel')!.opts).toEqual({ trigger: 'interrupt' });
    expect(pushed(host, 'cloudpunk.channel')!.event.text).toContain('「调度」');
    clearEvents(host);
    plugin.send({ type: 'event', name: 'channel', busy: true, speaker: '调度', speaking: false });
    await until(() => !!pushed(host, 'cloudpunk.channel'));
    expect(pushed(host, 'cloudpunk.channel')!.opts).toEqual({ trigger: 'flush' });
    clearEvents(host);
    plugin.send({ type: 'event', name: 'channel', busy: false, speaker: '调度' });
    await until(() => !!pushed(host, 'cloudpunk.channel'));
    expect(pushed(host, 'cloudpunk.channel')!.opts).toEqual({ trigger: 'piggyback' });
  });

  it('a new quest wakes the model with its marker distance; a district change rides along', async () => {
    const { plugin, host } = await setup();
    plugin.send({ type: 'event', name: 'quest_added', id: 'Task001', who: 'CONTROL', text: '前往云通总部', distance: 443 });
    plugin.send({ type: 'event', name: 'sector', sector: '上中城区' });
    await until(() => !!pushed(host, 'cloudpunk.place'));
    const quest = pushed(host, 'cloudpunk.quest')!;
    expect(quest.event).toMatchObject({ source: 'cloudpunk', senderKey: 'cloudpunk' });
    expect(quest.event.text).toContain('443 米');
    expect(quest.opts).toEqual({ trigger: 'flush' });
    expect(pushed(host, 'cloudpunk.place')!.opts).toEqual({ trigger: 'piggyback' });
  });
});

describe('navigator events', () => {
  it('turn prompts and low fuel wake the model, a new route rides along; prompts switched off are dropped', async () => {
    const { plugin, host, cfg } = await setup();
    plugin.send({ type: 'event', name: 'maneuver', kind: 'left', inM: 180, remainingM: 1200, target: '加油站' });
    plugin.send({ type: 'event', name: 'rerouted', target: '加油站', routeM: 900 });
    plugin.send({ type: 'event', name: 'fuel', fuel: 9, maxFuel: 40, percent: 22 });
    await until(() => !!pushed(host, 'cloudpunk.fuel'));
    const turn = host.events.findIndex((e) => e.type === 'cloudpunk.route');
    expect(host.events[turn]!.text).toContain('180 米后左转');
    expect(host.pushOpts[turn]).toEqual({ trigger: 'flush' });
    expect(host.events.find((e) => e.text.includes('重新规划'))).toBeTruthy();
    expect(pushed(host, 'cloudpunk.fuel')!.opts).toEqual({ trigger: 'flush' });
    clearEvents(host);
    cfg.navPrompts = false;
    plugin.send({ type: 'event', name: 'maneuver', kind: 'right', inM: 150, remainingM: 800, target: '加油站' });
    plugin.send({ type: 'event', name: 'sector', sector: '髓区' });
    await until(() => !!pushed(host, 'cloudpunk.place'));
    expect(pushed(host, 'cloudpunk.route')).toBeNull();
  });
});

describe('tools', () => {
  it('places passes the query and lists ids, kinds, distance and direction', async () => {
    const { plugin, tool } = await setup();
    plugin.replies.places = () => ({ ok: true, result: { places: [{ id: 'p1a2b3c', name: '加油站', kind: '加油站', distance: 340, dy: -25, bearing: '右前方' }], total: 120, kinds: ['商店×30', '加油站×6'] } });
    const out = await tool('cloudpunk_places')({ query: '最近的加油站' });
    expect(plugin.got.find((m) => m.method === 'places')).toMatchObject({ args: { query: '最近的加油站', limit: 8 } });
    expect(out).toContain('- p1a2b3c 加油站:右前方 340 米,低 25 米');
    expect(out).toContain('商店×30、加油站×6');
  });

  it('tools say the game is not connected instead of failing silently', async () => {
    const world = new CloudpunkWorld({ cfg: config(1), timezone: 'UTC' });
    const nav = world.tools().find((t) => t.name === 'cloudpunk_navigate')!;
    expect(await nav.handler({}, {} as never)).toMatchObject({ failed: true });
  });

  it('navigate sends the target and says how far the route is', async () => {
    const { plugin, tool } = await setup();
    plugin.replies.navigate = () => ({ ok: true, result: { target: '前往云通总部', routeM: 1197, straightM: 455, phase: 'drive', parking: [1, 2, 3] } });
    const out = await tool('cloudpunk_navigate')({ drive: true });
    expect(plugin.got.find((m) => m.method === 'navigate')).toMatchObject({ args: { drive: true } });
    expect(out).toBe('开始自动驾驶:去「前往云通总部」,路线约 1197 米(直线 455 米),终点是旁边的停车位。');
  });

  it('a plugin refusal comes back as a failed tool result with the game reason', async () => {
    const { plugin, tool } = await setup();
    plugin.replies.navigate = () => ({ ok: false, error: '现在不能导航（menu）' });
    expect(await tool('cloudpunk_navigate')()).toEqual({ text: '没执行：现在不能导航（menu）', failed: true });
  });

  it('status with see attaches the picture as a JPEG', async () => {
    const { plugin, tool } = await setup();
    plugin.replies.state = () => ({ ok: true, result: { type: 'state', mode: 'car', vr: false, sector: '上中城区', money: 2310, quests: [] } });
    plugin.replies.snapshot = () => ({ ok: true, result: { mime: 'image/jpeg', width: 960, height: 540, data: Buffer.from('jpg').toString('base64') } });
    const out = (await tool('cloudpunk_status')({ see: true })) as { text: string; blobs: Array<{ mime: string }> };
    expect(out.text).toContain('上中城区');
    expect(out.blobs[0].mime).toBe('image/jpeg');
  });
});

describe('parsing', () => {
  it('an overlay address of any of the three Worlds turns into its stream', () => {
    expect(streamUrlOf('http://127.0.0.1:7792/overlay')).toBe('http://127.0.0.1:7792/stream');
    expect(streamUrlOf('127.0.0.1:7796/')).toBe('http://127.0.0.1:7796/stream');
    expect(streamUrlOf('http://127.0.0.1:7797/stream')).toBe('http://127.0.0.1:7797/stream');
    expect(streamUrlOf('')).toBeNull();
  });

  it('overlay pages are told apart by their titles', () => {
    expect(overlayKindOf('<title>Bilibili Overlay</title>')).toBe('bilibili');
    expect(overlayKindOf('<title>语音识别 Overlay</title>')).toBe('asr');
    expect(overlayKindOf('<title>演出 Overlay</title>')).toBe('vtuber');
  });

  it('an OBS scene gives its visible browser sources at their place and size, fitted into bounds', () => {
    const l = layoutFromObsScene(OBS_COLLECTION, '云朋克直播间', [1600, 1000])!;
    expect(l.layers.map((x) => x.name)).toEqual(['Corti Overlay', 'Stream Overlay']);
    expect(l.layers[0]).toMatchObject({ x: -89, y: 0, pageW: 1920, pageH: 1080 });
    expect(l.layers[0]!.w).toBeCloseTo(1777.8, 1);
    expect(l.layers[0]!.h).toBeCloseTo(1000, 1);
    expect(l.layers[1]!.w).toBeCloseTo(1600.1, 1);
    expect(layoutFromObsScene(OBS_COLLECTION, '别的场景', [1600, 1000])).toBeNull();
  });

  it('a layout written by hand keeps what it says and fills the rest', () => {
    expect(parseLayout('')).toBeNull();
    expect(parseLayout('{not json')).toBeNull();
    expect(parseLayout('{"canvas":[1280,720],"layers":[{"url":"http://a/","on":false},{"name":"no url"}]}')!.layers)
      .toEqual([{ name: 'http://a/', url: 'http://a/', x: 0, y: 0, w: 1920, h: 1080, pageW: 1920, pageH: 1080, on: false }]);
  });

  it('subtitle cues become timed lines; a cut clears; other messages are ignored', () => {
    expect(linesOf({ type: 'subtitle', cues: [{ text: '右转', atMs: 120, speakMs: 900 }, { text: '', atMs: 0, speakMs: 100 }] })).toEqual([{ atMs: 120, line: { text: '右转', seconds: 0.9 } }]);
    expect(linesOf({ type: 'subtitle.cut' })).toEqual([]);
    expect(linesOf({ type: 'cue' })).toBeNull();
  });
});
