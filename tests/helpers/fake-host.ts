/** World 测试共用的假宿主：记录推送的事件与唤醒口径；事件库可以塞事件(给弹幕转发测试用)。 */
import type { EventEnvelope, EventRangeQuery, PushOptions, WorldHost } from 'cortico/core/types.ts';

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  pushOpts: Array<PushOptions | undefined> = [];
  /** 共享事件库里别的 World 推的事件 */
  shared: EventEnvelope[] = [];
  acceptsImages = true;

  pushDeferred(): void {}
  store = {
    get: (c: number) => this.shared.find((e) => e.cursor === c),
    latestCursor: () => (this.shared.length ? this.shared[this.shared.length - 1].cursor : 0),
    range: (q: EventRangeQuery) => this.shared.filter((e) => (q.fromCursor === undefined || e.cursor >= q.fromCursor) && (q.toCursor === undefined || e.cursor <= q.toCursor) && (!q.source || e.source === q.source)),
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => this.acceptsImages, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 模拟别的 World(bilibili)推了一条事件 */
  addShared(e: Omit<EventEnvelope, 'cursor'>): void {
    this.shared.push({ ...e, cursor: this.shared.length + 1 } as EventEnvelope);
  }

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }
  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}
