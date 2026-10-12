export class AgentStreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentStreamTimeoutError';
  }
}

/** Tracks first-event, inactivity, and absolute turn deadlines. */
export class StreamDeadlinePolicy {
  private lastActivityAt: number;
  private sawActivity = false;

  constructor(
    private startedAt: number,
    private firstEventTimeoutMs: number,
    private idleTimeoutMs: number,
    private maxTurnTimeoutMs: number,
  ) {
    this.lastActivityAt = startedAt;
  }

  markActivity(now: number): void {
    this.sawActivity = true;
    this.lastActivityAt = now;
  }

  nextWaitMs(now: number): number {
    const phaseDeadline = (this.sawActivity ? this.lastActivityAt + this.idleTimeoutMs : this.startedAt + this.firstEventTimeoutMs);
    const totalDeadline = this.startedAt + this.maxTurnTimeoutMs;
    return Math.max(0, Math.min(phaseDeadline, totalDeadline) - now);
  }

  timeoutMessage(now: number): string {
    if (now - this.startedAt >= this.maxTurnTimeoutMs) {
      return `Agent turn exceeded the ${Math.round(this.maxTurnTimeoutMs / 60_000)} minute maximum`;
    }
    if (!this.sawActivity) {
      return `Agent produced no event within ${Math.round(this.firstEventTimeoutMs / 1000)} seconds`;
    }
    return `Agent stream was silent for ${Math.round(this.idleTimeoutMs / 60_000)} minutes`;
  }
}

export async function readWithStreamDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  policy: StreamDeadlinePolicy,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>['read']>>> {
  const waitMs = policy.nextWaitMs(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AgentStreamTimeoutError(policy.timeoutMessage(Date.now()))), waitMs);
    timer.unref?.();
  });
  try {
    const chunk = await Promise.race([reader.read(), timeout]);
    if (!chunk.done) policy.markActivity(Date.now());
    return chunk;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
