/**
 * Arms a fail-safe after a user aborts a task. Some agent runtimes can ignore
 * AbortSignal while blocked in native I/O, leaving the per-session queue locked
 * forever. If the same task is still active after the grace period, restart the
 * daemon so PM2 can clear the orphaned child and restore message processing.
 */
export function armAbortedTaskWatchdog(
  controller: AbortController,
  isStillActive: () => boolean,
  onStuck: () => void,
  graceMs = 15_000,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    if (controller.signal.aborted && isStillActive()) onStuck();
  }, graceMs);
  timer.unref?.();
  return timer;
}

/** Periodic daemon recycling is a last-resort guard against SDK false-health. */
export function shouldRecycleIdleDaemon(
  startedAtMs: number,
  nowMs: number,
  activeTasks: boolean,
  maxAgeMs: number,
): boolean {
  return !activeTasks && nowMs - startedAtMs >= maxAgeMs;
}
