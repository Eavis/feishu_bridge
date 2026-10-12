export interface WsConnectionHealth {
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'unknown';
  reconnectAttempts?: number;
  lastConnectTime?: number;
  nextConnectTime?: number;
}

export interface WsHealthDecision {
  healthy: boolean;
  shouldRestart: boolean;
  unhealthyForMs: number;
  reason: string;
}

/** Stateful watchdog policy kept separate so recovery paths are testable. */
export class WsHealthWatchdog {
  private unhealthySince: number | null = null;

  constructor(private maxUnhealthyMs = 2 * 60 * 1000) {}

  inspect(health: WsConnectionHealth, now = Date.now()): WsHealthDecision {
    if (health.state === 'connected') {
      this.unhealthySince = null;
      return { healthy: true, shouldRestart: false, unhealthyForMs: 0, reason: 'connected' };
    }
    if (this.unhealthySince === null) this.unhealthySince = now;
    const unhealthyForMs = Math.max(0, now - this.unhealthySince);
    const attempts = health.reconnectAttempts ?? 0;
    const reason = `${health.state}${attempts ? ` (${attempts} reconnect attempt${attempts === 1 ? '' : 's'})` : ''}`;
    return {
      healthy: false,
      shouldRestart: health.state === 'failed' || unhealthyForMs >= this.maxUnhealthyMs,
      unhealthyForMs,
      reason,
    };
  }
}
