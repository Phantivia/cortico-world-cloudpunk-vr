/**
 * Checks the real World against the running game (CloudpunkVR plugin on 127.0.0.1:47660), without a bot or a model.
 * A fake vtuber World stage stream gives the lines and a fake overlay page stands in for the stream's overlay layer (in
 * VR the real mirror opens it in headless Edge); the script goes on air the way the 开播 button does, sends lines, then
 * reads back the plugin's live state, the mirror and the Spout preview (written to <out dir>).
 *
 *   npx tsx scripts/live-check.ts <out dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CLOUDPUNK_DEFAULTS } from '../src/config.ts';
import { CloudpunkWorld } from '../src/world.ts';

const out = process.argv[2] ?? 'live-check-out';
mkdirSync(out, { recursive: true });

function overlay(title: string) {
  const subs: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/overlay') { res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<title>${title}</title>`); return; }
    if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<body style="margin:0;background:transparent"><div style="position:absolute;left:40px;top:40px;padding:24px;background:#1e88e5cc;color:#fff;font:48px sans-serif">overlay 镜像走通了</div></body>'); return; }
    if (req.url !== '/stream') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    subs.push(res);
  });
  return {
    subs,
    listen: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}/overlay`))),
    send: (m: Record<string, unknown>) => { for (const s of subs) s.write(`data: ${JSON.stringify(m)}\n\n`); },
    close: () => { for (const s of subs) s.destroy(); server.close(); },
  };
}

const events: Array<{ type: string; text: string }> = [];
const host = {
  log: { info: () => {}, warn: (...a: unknown[]) => console.log('warn', ...a), error: (...a: unknown[]) => console.log('error', ...a), debug: () => {} },
  pushEvent: async (e: { type: string; text: string }) => { events.push(e); console.log('event', e.type, e.text); },
  modelFacts: { accepts: () => true, model: () => 'check', contextWindow: () => undefined },
} as never;

const vt = overlay('演出 Overlay');
const page = overlay('Check Overlay');
const cfg = structuredClone(CLOUDPUNK_DEFAULTS);
cfg.corti.subtitleUrl = await vt.listen();
const pageUrl = (await page.listen()).replace(/\/overlay$/, '/page');
cfg.overlay.layout = JSON.stringify({ canvas: [1920, 1080], layers: [{ name: '检查页', url: pageUrl, x: 0, y: 0, w: 1920, h: 1080, pageW: 1920, pageH: 1080 }], source: 'live-check' });
cfg.corti.zoom = 1;
cfg.corti.y = 0.5;

const world = new CloudpunkWorld({ cfg, timezone: 'Asia/Shanghai' });
await world.start(host);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 120 && !world.bridge.connected; i++) await wait(500);
if (!world.bridge.connected) { console.log('FAIL: game not connected'); process.exit(1); }
console.log('connected, vr =', world.bridge.hello?.vr);
for (let i = 0; i < 360 && !['car', 'car_chase', 'foot'].includes(world.state?.mode ?? ''); i++) await wait(500);
console.log('in game:', world.state?.mode, world.state?.sector);
await wait(3000);

const detect = (await world.invoke('detect')) as Record<string, string>;
console.log('detect', detect);

console.log('start:', ((await world.invoke('start')) as { text: string }).text);
for (let i = 0; i < 20 && vt.subs.length === 0; i++) await wait(250);
console.log('subscribed', vt.subs.length);
await wait(1500);

vt.send({ type: 'subtitle', cues: [{ text: '我是可缇，这句台词是从 vtuber World 的演出流来的。', atMs: 0, speakMs: 3500 }] });
await wait(2500);

const state = (await world.invoke('state')) as { live: unknown; feeds: unknown; lastLine: unknown };
console.log('live', JSON.stringify(state.live));
console.log('feeds', JSON.stringify(state.feeds));
console.log('lastLine', JSON.stringify(state.lastLine));
writeFileSync(join(out, 'state.json'), JSON.stringify(state, null, 2));
for (let i = 0; i < 20 && world.mirror.state === 'starting'; i++) await wait(500);
await wait(2000);
const ov = (await world.invoke('overlay', [true])) as { state: string; detail: string; layers: Array<{ frames: number; error: string | null; png?: string }> };
console.log('overlay', ov.state, ov.detail, JSON.stringify(ov.layers.map((l) => ({ frames: l.frames, error: l.error }))));
if (ov.layers[0]?.png) writeFileSync(join(out, 'overlay-layer0.png'), Buffer.from(ov.layers[0].png, 'base64'));

const p = (await world.invoke('preview', [640])) as { live: boolean; problem?: string; frame?: { data: string }; box?: { data: string }; sender?: string };
console.log('preview live', p.live, p.sender ?? p.problem ?? '');
if (p.frame) writeFileSync(join(out, 'preview-frame.jpg'), Buffer.from(p.frame.data, 'base64'));
if (p.box) writeFileSync(join(out, 'preview-box.jpg'), Buffer.from(p.box.data, 'base64'));

vt.send({ type: 'subtitle', cues: [{ text: '再来一句，看看截图里通讯框是不是在打字。', atMs: 0, speakMs: 4000 }] });
await wait(2500);
const seen = (await world.tools().find((t) => t.name === 'cloudpunk_status')!.handler({ see: true }, {} as never)) as { text: string; blobs?: Array<{ bytes: Buffer }> } | string;
if (typeof seen === 'string') console.log('status:', seen);
else {
  console.log('status:', seen.text);
  if (seen.blobs?.[0]) writeFileSync(join(out, 'game.jpg'), seen.blobs[0].bytes);
}
await wait(4000);
console.log('stop:', ((await world.invoke('stop')) as { text: string }).text);
await wait(1000);
console.log('subscribed after stop', vt.subs.filter((s) => !s.destroyed && !s.writableEnded).length);
await world.stop();
for (const o of [vt, page]) o.close();
console.log('events', events.map((e) => e.type).join(' '));
process.exit(0);
