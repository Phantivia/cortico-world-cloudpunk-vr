/**
 * 云朋克 World 的四个页签：开播(一键开始和各条接线的状态)、可缇画面(Spout 预览和取景、显示位置、台词来源)、
 * 直播 overlay(OBS 叠在游戏上的那层搬进头显：有哪几层、实时画面、摆在哪)、游戏(程序、启动方式、现状)。
 * 改动经 ctx.setConfig 写回配置组，World 一秒内把它交给游戏。浏览器侧不 import Node 模块。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { CloudpunkConfigSection } from '../config.ts';
import { GROUP_CORTI, GROUP_GAME, GROUP_OVERLAY } from '../config.ts';

type FeedState = 'off' | 'connecting' | 'live' | 'error';
interface FeedView { state: FeedState; detail: string; received: number; lastAt: number }

interface LiveView {
  onAir: boolean;
  channel: { where: string; npc: boolean; speaking: boolean; spout: { sender: string; width: number; height: number } | null; problem: string | null };
  overlay: { built: boolean; visible: boolean; layers: number; live: number };
  senders: string[];
}

interface PanelState {
  exe: string;
  exists: boolean;
  running: boolean;
  connected: boolean;
  vr: boolean;
  lamp: string;
  detail: string;
  onAir: boolean;
  game: { mode: string; sector: string | null; text: string } | null;
  live: LiveView | null;
  feeds: { subtitle: FeedView };
  overlay: { state: string; detail: string; layout: string; layers: number; live: number };
  lastLine: { text: string; at: number } | null;
  cfg: CloudpunkConfigSection;
}

interface Reply { text: string }

interface Preview {
  live: boolean;
  problem?: string;
  sender?: string;
  width?: number;
  height?: number;
  frame?: { mime: string; width: number; height: number; data: string };
  box?: { mime: string; data: string } | null;
}

const P = 'worlds.cloudpunk';

const WHERE: Record<string, string> = {
  off: '没开播',
  idle: '等画面(Spout 没收到)',
  npc: 'NPC 占着频道',
  car_screen: '驾驶舱通讯屏',
  hud: '界面左下角',
  'hud+wrist': '界面左下角 + 左手腕',
  wrist: '左手腕',
  hidden: '这会儿不显示(菜单、全图或读条)',
};

const FEED_TEXT: Record<FeedState, string> = { off: '没接', connecting: '连接中', live: '已接上', error: '连不上' };

function feedPill(ui: WebUiPanelContext['ui'], f: FeedView, url: string, onAir: boolean): HTMLElement {
  if (!url.trim()) return ui.pill('没填地址', 'off');
  if (f.state === 'off') return ui.pill(onAir ? '等游戏连上' : '开始后接', 'plain');
  return ui.pill(FEED_TEXT[f.state], f.state === 'live' ? 'on' : f.state === 'error' ? 'off' : 'plain');
}

/** 一个滑块：标签、拖动条和读数。拖动时连续回调，松手时提交。 */
function slider(ctx: WebUiPanelContext, label: string, o: { min: number; max: number; step: number; value: number; unit?: string; digits?: number; onInput?: (v: number) => void; onCommit: (v: number) => void }) {
  const { ui } = ctx;
  const wrap = ui.h('div', 'cp-slider');
  const name = ui.h('span', 'cp-slider-label', label);
  const input = ui.h('input');
  input.type = 'range';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step);
  input.value = String(o.value);
  const readout = ui.h('span', 'cp-slider-value mono');
  const show = () => { readout.textContent = `${Number(input.value).toFixed(o.digits ?? 0)}${o.unit ?? ''}`; };
  show();
  let editingUntil = 0;
  input.addEventListener('input', () => { editingUntil = Date.now() + 1500; show(); o.onInput?.(Number(input.value)); }, { signal: ctx.signal });
  input.addEventListener('change', () => { editingUntil = Date.now() + 1500; o.onCommit(Number(input.value)); }, { signal: ctx.signal });
  wrap.append(name, input, readout);
  return {
    el: wrap,
    input,
    /** 轮询回来的值;刚拖过的不被旧值顶回去。 */
    set(v: number) {
      if (Date.now() < editingUntil || document.activeElement === input) return;
      input.value = String(v);
      show();
    },
  };
}

const STYLE = `
.cp-slider { display: grid; grid-template-columns: 7em 1fr 5em; align-items: center; gap: 10px; margin: 6px 0; }
.cp-slider input[type=range] { width: 100%; accent-color: var(--accent, #4aa3ff); }
.cp-slider-value { text-align: right; opacity: .85; }
.cp-hero { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.cp-hero .btn { font-size: 1.05em; padding: 10px 28px; }
.cp-preview { display: flex; gap: 14px; flex-wrap: wrap; align-items: flex-start; }
.cp-preview canvas { border-radius: 6px; background: #1d1f24; max-width: 100%; touch-action: none; }
.cp-frame { cursor: move; }
.cp-box { width: 160px; height: 160px; border-radius: 6px; background: #0d171f; object-fit: cover; image-rendering: pixelated; }
.cp-caption { font-size: .85em; opacity: .7; margin-top: 4px; }
.cp-fov { width: 100%; max-width: 760px; border-radius: 6px; background: #12161b; touch-action: none; }
.cp-pre { white-space: pre-wrap; margin: 0; }
.cp-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.cp-row .field { flex: 1; min-width: 260px; }
`;

function addStyle(ctx: WebUiPanelContext): void {
  const style = ctx.ui.h('style');
  style.textContent = STYLE;
  ctx.root.append(style);
}

/** 写一组配置项，出错弹提示。 */
async function save(ctx: WebUiPanelContext, group: string, values: Record<string, string | number | boolean>): Promise<void> {
  try {
    await ctx.setConfig(group, values);
  } catch (e) {
    ctx.ui.toast(e instanceof Error ? e.message : String(e), 'bad');
  }
}

/** 同一键在 ms 内只写最后一次(拖动、滚轮)。 */
function debouncedSave(ctx: WebUiPanelContext, group: string, ms = 250) {
  let pending: Record<string, string | number | boolean> = {};
  let timer: { dispose(): void } | null = null;
  return (values: Record<string, string | number | boolean>) => {
    pending = { ...pending, ...values };
    timer?.dispose();
    timer = ctx.timeout(() => {
      const v = pending;
      pending = {};
      timer = null;
      void save(ctx, group, v);
    }, ms);
  };
}

async function act(ctx: WebUiPanelContext, btn: HTMLButtonElement, line: HTMLDivElement, run: () => Promise<Reply>, after?: () => void): Promise<void> {
  const hold = ctx.ui.disable(btn);
  try {
    const r = await run();
    line.textContent = r.text ?? '';
    line.classList.remove('bad');
  } catch (e) {
    line.textContent = e instanceof Error ? e.message : String(e);
    line.classList.add('bad');
  } finally {
    hold.dispose();
    after?.();
  }
}

/** 自动查找三个 World 的 overlay,找到的写进配置。 */
async function detect(ctx: WebUiPanelContext, line: HTMLDivElement): Promise<void> {
  line.textContent = '在本机端口上找…';
  line.classList.remove('bad');
  try {
    const found = await ctx.invoke<Partial<Record<'vtuber' | 'bilibili' | 'asr', string>>>('detect');
    const said: string[] = [];
    if (found.vtuber) { await save(ctx, GROUP_CORTI, { [`${P}.corti.subtitleUrl`]: found.vtuber }); said.push(`台词 ${found.vtuber}`); }
    const missing = (['vtuber', 'bilibili', 'asr'] as const).filter((k) => !found[k]).map((k) => ({ vtuber: 'vtuber World', bilibili: 'B 站直播间 World', asr: '语音识别 World' })[k]);
    line.textContent = `${said.length ? `找到并填好了:${said.join(';')}` : '一个也没找到'}${missing.length ? `。没找到 ${missing.join('、')}(那个 World 没开?)` : ''}`;
  } catch (e) {
    line.textContent = e instanceof Error ? e.message : String(e);
    line.classList.add('bad');
  }
}

// ---- 开播 -------------------------------------------------------------------------------

const livePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    addStyle(ctx);

    const hero = ui.sheet({ title: '开播', desc: '开始：没开游戏就按「游戏」页的方式启动;可缇接上游戏的通讯频道(驾驶舱通讯屏、界面左下角、左手腕);直播间那层 overlay 搬进头显。收工只撤下这些，游戏照常开着。' });
    const statePill = ui.h('span');
    const startLine = ui.msgline();
    const startBtn = ui.button('开始', {
      variant: 'primary',
      onClick: () => void act(ctx, startBtn, startLine, () => ctx.invoke<Reply>('start'), () => void load()),
    });
    const stopBtn = ui.button('收工', {
      variant: 'danger',
      onClick: async () => {
        if (!(await ui.confirm({ title: '收工？', body: '通讯框和头显里的 overlay 撤下，台词流和无头浏览器关掉;游戏不关。', danger: true }))) return;
        void act(ctx, stopBtn, startLine, () => ctx.invoke<Reply>('stop'), () => void load());
      },
    });
    const heroRow = ui.h('div', 'cp-hero');
    heroRow.append(startBtn, stopBtn, statePill);
    hero.body.append(heroRow, startLine);

    const wires = ui.sheet({ title: '接线', desc: '台词来源是 vtuber World 的 overlay 地址，空着时自动在本机找;头显里的 overlay 照 OBS 场景摆(在「直播 overlay」页)。' });
    const table = ui.table({ head: ['', '状态', '说明'] });
    const detectLine = ui.msgline();
    const detectBtn = ui.button('自动查找地址', { onClick: () => { const hold = ui.disable(detectBtn); void detect(ctx, detectLine).finally(() => { hold.dispose(); void load(); }); } });
    const testLine = ui.msgline();
    const lineBtn = ui.button('试显一句台词', { onClick: () => void act(ctx, lineBtn, testLine, () => ctx.invoke<Reply>('testLine')) });

    const actions = ui.actions();
    actions.append(detectBtn, lineBtn);
    wires.body.append(table.el, actions, detectLine, testLine);

    const now = ui.sheet({ title: '游戏现状', desc: '和可缇看到的一样。' });
    const nowText = ui.h('pre', 'mono cp-pre', '—');
    now.body.append(nowText);

    ctx.root.append(hero.el, wires.el, now.el);

    const load = async () => {
      const s = await ctx.invoke<PanelState>('state');
      startBtn.disabled = s.onAir;
      stopBtn.disabled = !s.onAir;
      startBtn.textContent = s.onAir ? '直播中' : '开始';
      statePill.replaceChildren(ui.pill(s.onAir ? '直播中' : '没开始', s.onAir ? 'on' : 'plain'));
      const ch = s.live?.channel;
      const age = (t: number) => (t ? `${Math.max(0, Math.round((Date.now() - t) / 1000))} 秒前` : '');
      table.clear();
      table.addRow(['游戏插件', ui.pill(s.connected ? (s.vr ? '已连接(VR)' : '已连接') : s.running ? '开着，没连上' : '没开', s.connected ? 'on' : 'off'), s.connected ? s.detail : s.exists ? s.exe : `找不到 ${s.exe}`]);
      table.addRow(['可缇画面', ui.pill(ch?.spout ? '收到了' : s.connected ? '没收到' : '—', ch?.spout ? 'on' : 'off'),
        ch?.spout ? `${ch.spout.sender} ${ch.spout.width}×${ch.spout.height}` : ch?.problem ?? '游戏连上后才看得到']);
      table.addRow(['可缇台词', feedPill(ui, s.feeds.subtitle, s.cfg.corti.subtitleUrl, s.onAir),
        s.lastLine ? `${age(s.lastLine.at)}:${s.lastLine.text}` : s.cfg.corti.subtitleUrl || '没填台词来源时显示模型输出的文字']);
      const ov = s.overlay;
      table.addRow(['直播 overlay', ui.pill(!s.cfg.overlay.on ? '关着' : ov.state === 'live' ? `${ov.live}/${ov.layers} 层有画面` : ov.state === 'error' ? '出错' : ov.state === 'starting' ? '启动中' : s.onAir ? (s.vr ? '等画面' : '只在 VR 里显示') : '开始后打开', ov.state === 'live' ? 'on' : ov.state === 'error' ? 'off' : 'plain'),
        [ov.layout, ov.detail].filter(Boolean).join(';') || '—']);
      table.addRow(['通讯框', ui.pill(ch ? WHERE[ch.where] ?? ch.where : '—', ch && ['car_screen', 'hud', 'hud+wrist', 'wrist'].includes(ch.where) ? 'on' : 'plain'), ch?.npc ? 'NPC 通话结束后回来' : '']);
      nowText.textContent = s.game?.text ?? (s.connected ? '—' : '游戏没连上');
    };
    ctx.interval(() => { void load().catch(() => {}); }, 1500);
    void load().catch((e: unknown) => { startLine.textContent = String(e); startLine.classList.add('bad'); });
  },
};

// ---- 可缇画面 ---------------------------------------------------------------------------

const cortiPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    addStyle(ctx);
    const write = debouncedSave(ctx, GROUP_CORTI);
    let cfg: CloudpunkConfigSection['corti'] | null = null;
    let frameAspect = 16 / 9;

    // 预览：整个画面 + 方框取景;拖动挪中心，滚轮缩放
    const prev = ui.sheet({ title: '预览', desc: '左边是 VTube Studio 送来的整个画面，亮框是通讯框里显示的那一块(虚线框是驾驶舱出框全息的全身取景):在画面上拖动挪位置，滚轮缩放;也可以在 VTube Studio 里挪人物。右边是方框里的样子(游戏里再套 NPC 全息效果)。游戏开着才有预览。' });
    const canvas = ui.h('canvas', 'cp-frame');
    canvas.width = 480;
    canvas.height = 270;
    const boxImg = ui.h('img', 'cp-box');
    const boxWrap = ui.h('div');
    boxWrap.append(boxImg, ui.h('div', 'cp-caption', '方框里'));
    const row = ui.h('div', 'cp-preview');
    row.append(canvas, boxWrap);
    const prevLine = ui.msgline('读取中…');
    const frameImg = new Image();
    let hasFrame = false;
    const zoomS = slider(ctx, '放大', { min: 0.5, max: 6, step: 0.05, value: 1.6, digits: 2, unit: '×', onInput: (v) => { if (cfg) { cfg.zoom = v; draw(); } }, onCommit: (v) => write({ [`${P}.corti.zoom`]: v }) });
    const xS = slider(ctx, '左右', { min: -0.5, max: 1.5, step: 0.01, value: 0.5, digits: 2, onInput: (v) => { if (cfg) { cfg.x = v; draw(); } }, onCommit: (v) => write({ [`${P}.corti.x`]: v }) });
    const yS = slider(ctx, '上下', { min: -0.5, max: 1.5, step: 0.01, value: 0.62, digits: 2, onInput: (v) => { if (cfg) { cfg.y = v; draw(); } }, onCommit: (v) => write({ [`${P}.corti.y`]: v }) });
    prev.body.append(row, prevLine, zoomS.el, xS.el, yS.el);
    const popZoomS = slider(ctx, '出框取景', { min: 0.3, max: 4, step: 0.05, value: 1, digits: 2, unit: '×', onInput: (v) => { if (cfg) { cfg.popZoom = v; draw(); } }, onCommit: (v) => write({ [`${P}.corti.popZoom`]: v }) });
    const popSizeS = slider(ctx, '出框身高', { min: 0.1, max: 0.8, step: 0.01, value: 0.3, digits: 2, unit: ' m', onCommit: (v) => write({ [`${P}.corti.popSize`]: v }) });

    const crop = () => {
      const z = Math.max(0.2, cfg?.zoom ?? 1.6);
      const h = 1 / z;
      const w = h / frameAspect;
      return { x: (cfg?.x ?? 0.5) - w / 2, y: (cfg?.y ?? 0.62) - h / 2, w, h };
    };
    // the cockpit pop-out's full-figure crop, as the plugin computes it (CooHoloFigure.Crop)
    const popCrop = () => {
      const h = 1 / Math.max(0.3, cfg?.popZoom ?? 1);
      const w = h * 0.68 / frameAspect;
      const y = Math.min(Math.max((cfg?.y ?? 0.62) - h * 0.55, 0), Math.max(0, 1 - h));
      return { x: (cfg?.x ?? 0.5) - w / 2, y, w, h };
    };
    const draw = () => {
      const g = canvas.getContext('2d');
      if (!g) return;
      g.fillStyle = '#1d1f24';
      g.fillRect(0, 0, canvas.width, canvas.height);
      if (hasFrame) g.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
      const c = crop();
      const rx = c.x * canvas.width, ry = (1 - c.y - c.h) * canvas.height, rw = c.w * canvas.width, rh = c.h * canvas.height;
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.beginPath();
      g.rect(0, 0, canvas.width, canvas.height);
      g.rect(rx, ry, rw, rh);
      g.fill('evenodd');
      g.strokeStyle = '#7fd4ff';
      g.lineWidth = 2;
      g.strokeRect(rx, ry, rw, rh);
      if (cfg?.popOut) {
        const p = popCrop();
        g.setLineDash([6, 4]);
        g.strokeStyle = '#ffd27f';
        g.lineWidth = 1.5;
        g.strokeRect(p.x * canvas.width, (1 - p.y - p.h) * canvas.height, p.w * canvas.width, p.h * canvas.height);
        g.setLineDash([]);
      }
    };
    let drag: { px: number; py: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => { if (!cfg) return; drag = { px: e.offsetX, py: e.offsetY, x: cfg.x, y: cfg.y }; canvas.setPointerCapture(e.pointerId); }, { signal: ctx.signal });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || !cfg) return;
      cfg.x = +(drag.x + (e.offsetX - drag.px) / canvas.clientWidth).toFixed(3);
      cfg.y = +(drag.y - (e.offsetY - drag.py) / canvas.clientHeight).toFixed(3);
      xS.input.value = String(cfg.x); yS.input.value = String(cfg.y);
      xS.set(cfg.x); yS.set(cfg.y);
      draw();
      write({ [`${P}.corti.x`]: cfg.x, [`${P}.corti.y`]: cfg.y });
    }, { signal: ctx.signal });
    canvas.addEventListener('pointerup', () => { drag = null; }, { signal: ctx.signal });
    canvas.addEventListener('wheel', (e) => {
      if (!cfg) return;
      e.preventDefault();
      cfg.zoom = +Math.min(6, Math.max(0.5, cfg.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))).toFixed(3);
      zoomS.input.value = String(cfg.zoom);
      draw();
      write({ [`${P}.corti.zoom`]: cfg.zoom });
    }, { signal: ctx.signal, passive: false });

    // 来源
    const src = ui.sheet({ title: '画面来源', desc: 'VTube Studio:设置 → 摄像机 → 打开「Spout2 输出」;背景设成透明，人物外面会显示通讯框的底色。笔记本有两块显卡时，Windows 的显示卡设置里要把 VTube Studio 设成高性能(和游戏同一块)。' });
    const senderSel = ui.select({ options: [{ value: '', label: '自动(VTube Studio)' }], onChange: (v) => void save(ctx, GROUP_CORTI, { [`${P}.corti.sender`]: v }) });
    const flip = ui.checkbox('上下翻转', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.flip`]: c }) });
    const holo = ui.checkbox('NPC 全息效果(像素化、扫描线、撕裂噪点)', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.holo`]: c }) });
    const srcRow = ui.rowbar();
    srcRow.append(ui.field('Spout 发送端', senderSel), flip.el, holo.el);
    src.body.append(srcRow);

    // 显示位置
    const where = ui.sheet({ title: '显示在哪', desc: 'NPC 来电或当面说话时频道归 NPC,这些地方都会暂时撤下可缇，并告诉她被打断了。' });
    const inCar = ui.checkbox('驾驶舱通讯屏(方向盘左边)', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.inCar`]: c }) });
    const onFoot = ui.checkbox('界面左下角(步行、追尾视角)', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.onFoot`]: c }) });
    const onWrist = ui.checkbox('左前臂小屏(VR 步行)', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.onWrist`]: c }) });
    const fufu = ui.checkbox('副驾驶座上的可缇玩偶', { onChange: (c) => void save(ctx, GROUP_CORTI, { [`${P}.corti.fufu`]: c }) });
    const popOut = ui.checkbox('驾驶舱出框全息(全身从通讯屏上站起来)', { onChange: (c) => { if (cfg) { cfg.popOut = c; draw(); } void save(ctx, GROUP_CORTI, { [`${P}.corti.popOut`]: c }); } });
    const nameIn = ui.input({ placeholder: '可缇', onCommit: (v) => void save(ctx, GROUP_CORTI, { [`${P}.corti.name`]: v.trim() || '可缇' }) });
    const whereRow = ui.rowbar();
    whereRow.append(inCar.el, popOut.el, fufu.el, onFoot.el, onWrist.el);
    const nameRow = ui.rowbar();
    nameRow.append(ui.field('通讯框上的名字', nameIn));
    where.body.append(whereRow, popZoomS.el, popSizeS.el, nameRow);

    // 台词
    const lines = ui.sheet({ title: '台词来源', desc: 'vtuber World 的 overlay 地址(OBS 里那条)。可缇说一句，通讯框里就跟着语音逐字打出这一句。留空则显示模型输出的文字。' });
    const urlIn = ui.input({ placeholder: 'http://127.0.0.1:7792/overlay', cls: 'mono', onCommit: (v) => void save(ctx, GROUP_CORTI, { [`${P}.corti.subtitleUrl`]: v.trim() }) });
    const probeLine = ui.msgline();
    const probeBtn = ui.button('检测', {
      onClick: async () => {
        const r = await ctx.invoke<{ ok: boolean; kind: string | null; detail: string }>('probe', [urlIn.value]);
        probeLine.textContent = r.ok ? (r.kind === 'vtuber' ? '通了，是 vtuber World 的演出 overlay' : `通了，但这是 ${r.kind ?? '不认识的页面'}`) : `不通:${r.detail}`;
        probeLine.classList.toggle('bad', !(r.ok && r.kind === 'vtuber'));
      },
    });
    const testLine = ui.msgline();
    const testBtn = ui.button('试显一句', { onClick: () => void act(ctx, testBtn, testLine, () => ctx.invoke<Reply>('testLine')) });
    const urlRow = ui.h('div', 'cp-row');
    urlRow.append(urlIn, probeBtn, testBtn);
    lines.body.append(urlRow, probeLine, testLine);

    ctx.root.append(prev.el, src.el, where.el, lines.el);

    let filled = false;
    const loadState = async () => {
      const s = await ctx.invoke<PanelState>('state');
      const c = s.cfg.corti;
      if (!cfg || !drag) cfg = { ...c };
      zoomS.set(c.zoom); xS.set(c.x); yS.set(c.y); popZoomS.set(c.popZoom); popSizeS.set(c.popSize);
      const senders = s.live?.senders ?? [];
      const want = [{ value: '', label: '自动(VTube Studio)' }, ...senders.map((n) => ({ value: n, label: n }))];
      if (c.sender && !senders.includes(c.sender)) want.push({ value: c.sender, label: `${c.sender}(没在发)` });
      if (senderSel.options.length !== want.length || want.some((o, i) => senderSel.options[i]?.value !== o.value)) {
        senderSel.replaceChildren(...want.map((o) => { const op = ui.h('option', null, o.label); op.value = o.value; return op; }));
      }
      if (document.activeElement !== senderSel) senderSel.value = c.sender;
      flip.setChecked(c.flip); holo.setChecked(c.holo);
      inCar.setChecked(c.inCar); popOut.setChecked(c.popOut); fufu.setChecked(c.fufu); onFoot.setChecked(c.onFoot); onWrist.setChecked(c.onWrist);
      if (!filled || document.activeElement !== nameIn) nameIn.value = c.name;
      if (!filled || document.activeElement !== urlIn) urlIn.value = c.subtitleUrl;
      filled = true;
    };
    const loadPreview = async () => {
      const p = await ctx.invoke<Preview>('preview', [480]);
      if (!p.live || !p.frame) {
        prevLine.textContent = p.problem ?? '没有画面';
        prevLine.classList.add('bad');
        return;
      }
      prevLine.textContent = `${p.sender} ${p.width}×${p.height}`;
      prevLine.classList.remove('bad');
      frameAspect = (p.width ?? 16) / (p.height ?? 9);
      canvas.height = Math.round(canvas.width / frameAspect);
      await new Promise<void>((resolve) => { frameImg.onload = () => resolve(); frameImg.onerror = () => resolve(); frameImg.src = `data:${p.frame!.mime};base64,${p.frame!.data}`; });
      hasFrame = true;
      if (p.box) boxImg.src = `data:${p.box.mime};base64,${p.box.data}`;
      draw();
    };
    draw();
    ctx.interval(() => { void loadState().catch(() => {}); }, 2000);
    ctx.interval(() => { void loadPreview().catch(() => {}); }, 1000);
    void loadState().then(loadPreview).catch((e: unknown) => { prevLine.textContent = String(e); prevLine.classList.add('bad'); });
  },
};

// ---- 直播 overlay -----------------------------------------------------------------------

interface OverlayView {
  state: string;
  detail: string;
  layoutDetail: string;
  onAir: boolean;
  connected: boolean;
  vr: boolean;
  canvas: [number, number];
  layers: Array<{ name: string; url: string; x: number; y: number; w: number; h: number; on: boolean; frames: number; lastAt: number; error: string | null; png?: string }>;
  cfg: CloudpunkConfigSection['overlay'];
}

const overlayPanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    addStyle(ctx);
    const write = debouncedSave(ctx, GROUP_OVERLAY);

    const prev = ui.sheet({ title: '画面', desc: '头显里看到的就是这一层：OBS 叠在游戏上的浏览器源(可缇的演出层、直播间的写字板和弹幕、语音字幕)在无头 Edge 里打开，按 OBS 里的位置摆好。开播、游戏连着、戴着头显时才在跑。' });
    const canvas = ui.h('canvas', 'cp-fov');
    canvas.width = 960;
    canvas.height = 540;
    const status = ui.msgline('读取中…');
    prev.body.append(canvas, status);

    const layersSheet = ui.sheet({ title: '有哪几层', desc: '默认照 OBS 场景「云朋克直播间」读;也可以按本机找到的 overlay 铺满。某层不想在头显里看就关掉它。' });
    const table = ui.table({ head: ['显示', '层', '地址', '状态'] });
    const lineMsg = ui.msgline();
    const sceneIn = ui.input({ placeholder: '云朋克直播间', onCommit: (v) => void save(ctx, GROUP_OVERLAY, { [`${P}.overlay.obsScene`]: v.trim() || '云朋克直播间' }) });
    const importBtn = ui.button('照 OBS 场景摆', { variant: 'primary', onClick: () => void act(ctx, importBtn, lineMsg, () => ctx.invoke<Reply>('importObs'), () => void load()) });
    const autoBtn = ui.button('自动(先 OBS,后本机)', { onClick: () => void act(ctx, autoBtn, lineMsg, () => ctx.invoke<Reply>('autoLayout'), () => void load()) });
    const reloadBtn = ui.button('重新打开页面', { onClick: () => void act(ctx, reloadBtn, lineMsg, () => ctx.invoke<Reply>('reloadOverlay'), () => void load()) });
    const sceneRow = ui.h('div', 'cp-row');
    sceneRow.append(ui.field('OBS 场景', sceneIn), importBtn, autoBtn, reloadBtn);
    layersSheet.body.append(sceneRow, lineMsg, table.el);

    const place = ui.sheet({ title: '摆在哪', desc: '跟头部刚性锁定，转头一起转、不飘。默认和游戏界面差不多大、近一点画在它上面，略低于视线。' });
    const on = ui.checkbox('头显里显示', { onChange: (c) => void save(ctx, GROUP_OVERLAY, { [`${P}.overlay.on`]: c }) });
    const mk = (field: 'distance' | 'width' | 'pitch' | 'yaw' | 'opacity', label: string, min: number, max: number, step: number, unit: string, digits = 0) =>
      slider(ctx, label, { min, max, step, value: 0, unit, digits, onCommit: (v) => write({ [`${P}.overlay.${field}`]: v }) });
    const sl = {
      distance: mk('distance', '距离', 0.5, 4, 0.05, ' m', 2),
      width: mk('width', '宽度', 0.5, 4, 0.05, ' m', 2),
      pitch: mk('pitch', '上下', -30, 30, 1, '°'),
      yaw: mk('yaw', '左右', -40, 40, 1, '°'),
      opacity: mk('opacity', '不透明度', 0.1, 1, 0.05, '', 2),
    };
    const onRow = ui.rowbar();
    onRow.append(on.el);
    place.body.append(onRow, sl.distance.el, sl.width.el, sl.pitch.el, sl.yaw.el, sl.opacity.el);

    ctx.root.append(prev.el, layersSheet.el, place.el);

    const images = new Map<number, HTMLImageElement>();
    let view: OverlayView | null = null;
    const draw = () => {
      const g = canvas.getContext('2d');
      if (!g || !view) return;
      const [cw, ch] = view.canvas;
      canvas.height = Math.round(canvas.width * ch / cw);
      const k = canvas.width / cw;
      g.fillStyle = '#20252c';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = 'rgba(255,255,255,.25)';
      g.font = '14px sans-serif';
      g.fillText('(游戏画面在这层下面)', 12, canvas.height - 12);
      view.layers.forEach((l, i) => {
        const img = images.get(i);
        if (l.on && img && img.complete && img.naturalWidth) g.drawImage(img, l.x * k, l.y * k, l.w * k, l.h * k);
      });
    };
    let filled = false;
    const load = async () => {
      const v = await ctx.invoke<OverlayView>('overlay', [true]);
      view = v;
      status.textContent = [
        v.state === 'live' ? `在跑:${v.detail}` : v.state === 'error' ? `出错:${v.detail}` : v.state === 'starting' ? '启动中' : !v.onAir ? '还没开播' : !v.connected ? '游戏没连上' : !v.vr ? '游戏不在 VR 里' : '没在跑',
        v.layoutDetail,
      ].filter(Boolean).join(';');
      status.classList.toggle('bad', v.state === 'error');
      table.clear(v.layers.length ? undefined : '没有层');
      v.layers.forEach((l, i) => {
        const box = ui.checkbox('', {
          checked: l.on,
          onChange: (c) => void ctx.invoke<Reply>('setLayer', [i, c]).then((r) => { lineMsg.textContent = r.text; void load(); }),
        });
        const age = l.lastAt ? `${Math.max(0, Math.round((Date.now() - l.lastAt) / 1000))} 秒前更新` : '';
        table.addRow([box.el, l.name, l.url, l.error ?? (l.frames ? `${l.frames} 帧 · ${age}` : '—')]);
        if (l.png) {
          const img = images.get(i) ?? new Image();
          images.set(i, img);
          img.onload = () => draw();
          img.src = `data:image/png;base64,${l.png}`;
        }
      });
      on.setChecked(v.cfg.on);
      sl.distance.set(v.cfg.distance); sl.width.set(v.cfg.width); sl.pitch.set(v.cfg.pitch); sl.yaw.set(v.cfg.yaw); sl.opacity.set(v.cfg.opacity);
      if (!filled || document.activeElement !== sceneIn) sceneIn.value = v.cfg.obsScene;
      filled = true;
      draw();
    };
    ctx.interval(() => { void load().catch(() => {}); }, 1500);
    void load().catch((e: unknown) => { status.textContent = String(e); status.classList.add('bad'); });
  },
};

// ---- 游戏 -------------------------------------------------------------------------------

const gamePanel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    addStyle(ctx);

    const prog = ui.sheet({ title: '游戏程序', desc: '装了 CloudpunkVR 的游戏副本;Steam 客户端要开着，VR 启动时 SteamVR 也要开着。' });
    const exeIn = ui.input({ cls: 'mono', onCommit: (v) => void save(ctx, GROUP_GAME, { [`${P}.gameExe`]: v.trim() }) });
    const pick = ui.button('选择…', {
      onClick: async () => {
        const path = await ctx.pickPath({ kind: 'file', title: '选择 Cloudpunk.exe', currentPath: exeIn.value, extensions: ['.exe'] });
        if (path) { exeIn.value = path; await save(ctx, GROUP_GAME, { [`${P}.gameExe`]: path }); }
      },
    });
    const vr = ui.checkbox('以 VR 启动(-vrmode OpenVR)', { onChange: (c) => void save(ctx, GROUP_GAME, { [`${P}.launchVr`]: c }) });
    const stream = ui.checkbox('平稳直播画面(VR 时游戏窗口显示去抖动的第一人称，给 OBS 的游戏捕获)', { onChange: (c) => void save(ctx, GROUP_GAME, { [`${P}.streamView`]: c }) });
    const speed = slider(ctx, '自动驾驶速度', { min: 0.3, max: 1, step: 0.05, value: 0.85, digits: 2, unit: '×', onCommit: (v) => void save(ctx, GROUP_GAME, { [`${P}.autopilotSpeed`]: v }) });
    const launchLine = ui.msgline();
    const launchBtn = ui.button('启动游戏', { variant: 'primary', onClick: () => void act(ctx, launchBtn, launchLine, () => ctx.invoke<Reply>('launch'), () => void load()) });
    const exeRow = ui.h('div', 'cp-row');
    exeRow.append(exeIn, pick);
    const actions = ui.actions();
    actions.append(launchBtn);
    const vrRow = ui.rowbar();
    vrRow.append(vr.el);
    const streamRow = ui.rowbar();
    streamRow.append(stream.el);
    prog.body.append(exeRow, vrRow, streamRow, speed.el, actions, launchLine);

    const now = ui.sheet({ title: '现状', desc: '可缇查看游戏时看到的就是这些。' });
    const status = ui.h('span');
    const nowText = ui.h('pre', 'mono cp-pre', '—');
    now.body.append(status, nowText);

    ctx.root.append(prog.el, now.el);

    let filled = false;
    const load = async () => {
      const s = await ctx.invoke<PanelState>('state');
      if (!filled || document.activeElement !== exeIn) exeIn.value = s.exe;
      filled = true;
      vr.setChecked(s.cfg.launchVr);
      stream.setChecked(s.cfg.streamView);
      speed.set(s.cfg.autopilotSpeed);
      launchBtn.disabled = s.running || !s.exists;
      status.replaceChildren(ui.pill(s.connected ? (s.vr ? '已连接(VR)' : '已连接') : s.running ? '开着，插件没连上' : '没开', s.connected ? 'on' : 'plain'));
      nowText.textContent = s.game?.text ?? '';
    };
    ctx.interval(() => { void load().catch(() => {}); }, 2000);
    void load().catch((e: unknown) => { launchLine.textContent = String(e); launchLine.classList.add('bad'); });
  },
};

const bundle: WebUiClientBundle = { panels: { live: livePanel, corti: cortiPanel, overlay: overlayPanel, game: gamePanel } };

export default bundle;
