/**
 * 可缇的台词：vtuber World 演出流里的 subtitle。每段语音开播时发一次，cue 带文本、相对发出时刻的 atMs 和发声时长
 * speakMs;同一段播放中会以更准的时间重发，以最新一批为准;被打断时发 subtitle.cut。这里按 cue 的时刻把
 * 「这句、念多久」交给插件，游戏里的通讯框跟着语音逐字打出。
 */
export interface Line {
  text: string;
  seconds: number;
}

interface Cue {
  text?: string;
  atMs?: number;
  speakMs?: number;
  durMs?: number;
}

/** 演出流的一条消息 -> 要在哪些时刻说哪些句子;cut 返回 [];与台词无关返回 null。 */
export function linesOf(msg: { type?: unknown; cues?: unknown }): Array<{ atMs: number; line: Line }> | null {
  if (msg.type === 'subtitle.cut') return [];
  if (msg.type !== 'subtitle' || !Array.isArray(msg.cues)) return null;
  return (msg.cues as Cue[])
    .map((c) => ({ atMs: Number(c.atMs ?? 0), line: { text: String(c.text ?? ''), seconds: Number(c.speakMs ?? c.durMs ?? 0) / 1000 } }))
    .filter((c) => c.line.text.trim() && c.line.seconds > 0);
}

/** 一批 cue 顶替上一批;cut(空批)立即收声。 */
export class CueScheduler {
  private timers: NodeJS.Timeout[] = [];
  /** 最近一句的文本和时刻(给面板看)。 */
  last: { text: string; at: number } | null = null;

  constructor(private readonly say: (line: Line | null) => void) {}

  onMessage(msg: Record<string, unknown>): void {
    const cues = linesOf(msg as { type?: unknown; cues?: unknown });
    if (cues) this.schedule(cues);
  }

  schedule(cues: Array<{ atMs: number; line: Line }>): void {
    this.clear();
    if (cues.length === 0) {
      this.say(null);
      return;
    }
    for (const c of cues) {
      this.timers.push(setTimeout(() => {
        this.last = { text: c.line.text, at: Date.now() };
        this.say(c.line);
      }, Math.max(0, c.atMs)));
    }
  }

  clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
