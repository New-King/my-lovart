/** 工具执行期间产生的进度事件，由 stream adapter 合并进主事件流 */
export type AgentBusEvent = {
  type: "progress";
  progress: number;
  stage: string;
};

export class AgentEventBus {
  private items: AgentBusEvent[] = [];
  private waiters: Array<() => void> = [];

  push(event: AgentBusEvent): void {
    this.items.push(event);
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  shift(): AgentBusEvent | undefined {
    return this.items.shift();
  }

  /** 没有事件时挂起，最多等 ms 毫秒；给 stream adapter 做轮询用 */
  wait(ms: number): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        resolve();
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }
}