/** 把插件的状态帧和事件帧写成给模型看的短中文。只陈述游戏里的事实，不替模型下判断。 */
import type { TriggerMode } from 'cortico/core/types.ts';
import type { GameFrame, GameState, Quest } from './bridge.ts';

export const TAG = '[云朋克]';

const MODES: Record<string, string> = {
  loading: '读条中',
  menu: '在菜单里',
  dialogue: '在对话',
  map: '开着全图',
  window: '开着物品栏或商店',
  car: '在驾驶舱',
  car_chase: '在车里(追尾视角)',
  foot: '步行',
  none: '—',
};

export function modeText(mode: string): string {
  return MODES[mode] ?? mode;
}

export function questLine(q: Quest): string {
  const where = q.distance === undefined ? ',没有地图标记' : q.otherLevel ? `,在另一层，地图标记指着 ${q.distance} 米外通往那一层的升降梯` : `,标记在 ${q.distance} 米外`;
  const who = q.who ? `${q.who}:` : '';
  return `${who}${q.text}${q.progress ? `(${q.progress})` : ''}${where}`;
}

/** cloudpunk_status 的正文。 */
export function statusText(s: GameState): string {
  const lines: string[] = [];
  lines.push(`操作员${modeText(s.mode)}${s.sector ? `,在${s.sector}` : ''}${s.money !== undefined ? `,有 ${s.money} 信用点` : ''}。`);
  if (s.car && (s.mode === 'car' || s.mode === 'car_chase')) {
    lines.push(`车速 ${s.car.speedKmh} km/h,油 ${Math.round(s.car.fuel)}/${s.car.maxFuel}${s.car.inParking ? ',在停车位上' : ''}。`);
  } else if (s.car && s.pos) {
    const d = Math.round(Math.hypot(s.car.pos[0] - s.pos[0], s.car.pos[1] - s.pos[1], s.car.pos[2] - s.pos[2]));
    lines.push(`车在 ${d} 米外,油 ${Math.round(s.car.fuel)}/${s.car.maxFuel}。`);
  }
  if (s.dialogue) lines.push(`对话中 ${s.dialogue.speaker || '?'}:${s.dialogue.text}`);
  if (s.interact) lines.push(`面前可以交互:${s.interact}`);
  const qs = s.quests ?? [];
  if (qs.length) {
    lines.push('任务:');
    for (const q of qs) lines.push(`- [${q.id}] ${questLine(q)}`);
  } else lines.push('没有进行中的任务。');
  const ap = s.autopilot;
  if (ap && ap.phase !== 'off') {
    const next = ap.next ? `,${ap.next.inM} 米后${MANEUVERS[ap.next.kind] ?? ap.next.kind}` : '';
    lines.push(`导航:${ap.phase === 'guide' ? '操作员自己开，路线画着' : ap.phase === 'walk' ? '替操作员走过去' : '自动驾驶中'},去「${ap.target}」,还有约 ${ap.remainingM} 米${next}。`);
  }
  return lines.join('\n');
}

const MANEUVERS: Record<string, string> = { left: '左转', right: '右转', uturn: '掉头', up: '上升', down: '下降', arrive: '到达目的地', lift: '驶入升降梯' };

export interface PlacesResult {
  places: Array<{ id: string; name: string; kind: string; distance: number; dy: number; bearing: string }>;
  total: number;
  kinds: string[];
}

/** cloudpunk_places 的正文。 */
export function placesText(r: PlacesResult, query: string): string {
  const lines: string[] = [];
  if (!r.places.length) lines.push(query ? `地图上没找到「${query}」。` : '地图上还没有地点(游戏没进入或地图没加载)。');
  else {
    lines.push(query ? `「${query}」,由近到远:` : '最近的地点:');
    for (const p of r.places) {
      const height = Math.abs(p.dy) < 10 ? '' : `,${p.dy > 0 ? '高' : '低'} ${Math.abs(p.dy)} 米`;
      const kind = p.kind && p.kind !== p.name ? `[${p.kind}] ` : '';
      lines.push(`- ${p.id} ${kind}${p.name}:${p.bearing} ${p.distance} 米${height}`);
    }
  }
  if (r.kinds.length) lines.push(`地图上的地点种类:${r.kinds.join('、')}(共 ${r.total} 处)`);
  return lines.join('\n');
}

export interface Rendered {
  noun: string;
  text: string;
  trigger: TriggerMode;
}

/** 插件事件帧 -> 事件。 */
export function renderEvent(f: GameFrame): Rendered | null {
  const s = (k: string) => String(f[k] ?? '');
  switch (f.name) {
    case 'dialogue':
      return { noun: 'dialogue', text: `${TAG} ${f.remote === true ? '(通讯)' : ''}${s('speaker') || '?'}:${s('text')}`, trigger: 'debounce' };
    case 'unlocked': {
      const what = [s('title'), s('name'), s('amount')].filter(Boolean).join(' ');
      return { noun: 'found', text: `${TAG} 游戏提示获得:${what}`, trigger: 'debounce' };
    }
    case 'hint':
      return { noun: 'hint', text: `${TAG} 屏幕上的教程提示:${s('text')}`, trigger: 'piggyback' };
    case 'fuel':
      return { noun: 'fuel', text: `${TAG} 油量低:剩 ${s('percent')}%(${s('fuel')}/${s('maxFuel')})`, trigger: 'flush' };
    case 'rerouted':
      if (f.afterLift === true) return { noun: 'route', text: `${TAG} 出了升降梯，到了另一层，接着规划去「${s('target')}」,约 ${s('routeM')} 米`, trigger: 'piggyback' };
      return { noun: 'route', text: `${TAG} 操作员偏离了路线，已重新规划去「${s('target')}」,约 ${s('routeM')} 米`, trigger: 'piggyback' };
    case 'maneuver': {
      const kind = s('kind');
      if (kind === 'lift') return { noun: 'route', text: `${TAG} 导航:前面约 ${s('inM')} 米是升降梯，驶进去去另一层(目标「${s('target')}」)`, trigger: 'flush' };
      if (kind === 'arrive') return { noun: 'route', text: `${TAG} 导航:「${s('target')}」就在前面约 ${s('inM')} 米`, trigger: 'flush' };
      return { noun: 'route', text: `${TAG} 导航:${s('inM')} 米后${MANEUVERS[kind] ?? kind}(去「${s('target')}」还有约 ${s('remainingM')} 米)`, trigger: 'flush' };
    }
    case 'channel': {
      const who = s('speaker') ? `「${s('speaker')}」` : '';
      if (f.busy === true) {
        const cut = f.speaking === true;
        return {
          noun: 'channel',
          text: `${TAG} NPC${who}接进了通讯频道：你的画面和台词从操作员的通讯屏上撤下了${cut ? ',你正在说的这句在游戏里被打断(直播间和操作员仍听得到你的声音)' : ''}。`,
          trigger: cut ? 'interrupt' : 'flush',
        };
      }
      return { noun: 'channel', text: `${TAG} NPC${who}的通话结束，你回到了通讯屏上。`, trigger: 'piggyback' };
    }
    case 'quest_added':
      return { noun: 'quest', text: `${TAG} 新任务 [${s('id')}] ${questLine(f as unknown as Quest)}`, trigger: 'flush' };
    case 'quest_updated':
      return { noun: 'quest', text: `${TAG} 任务更新 [${s('id')}] ${questLine(f as unknown as Quest)}`, trigger: 'debounce' };
    case 'quest_done':
      return { noun: 'quest', text: `${TAG} 任务 [${s('id')}] 从任务栏消失了(完成或取消)`, trigger: 'debounce' };
    case 'arrived':
      return { noun: 'arrived', text: `${TAG} 到了「${s('target')}」:${s('how')}`, trigger: 'flush' };
    case 'autopilot':
      return { noun: 'autopilot', text: `${TAG} 自动驾驶${s('state') === 'guide' ? '交还给操作员' : '停了'}:${s('why')}`, trigger: 'flush' };
    case 'sector':
      return { noun: 'place', text: `${TAG} 进入${s('sector')}`, trigger: 'piggyback' };
    case 'mode': {
      const to = s('to');
      if (to === 'loading' || s('from') === 'loading' && to === 'none') return null;
      return { noun: 'mode', text: `${TAG} 操作员${modeText(to)}`, trigger: 'piggyback' };
    }
    case 'money': {
      const change = Number(f.change ?? 0);
      return { noun: 'money', text: `${TAG} 信用点 ${change >= 0 ? '+' : ''}${change},现在 ${s('money')}`, trigger: 'piggyback' };
    }
    case 'interact':
      return { noun: 'interact', text: `${TAG} 面前可以交互:${s('target')}`, trigger: 'piggyback' };
    default:
      return null;
  }
}
