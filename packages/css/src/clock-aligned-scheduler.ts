// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

interface SimulatorRef {
  isConnected: boolean;
  stationId: string;
  getAlignedIntervalSeconds(): number;
  sendClockAlignedMeterValues(): Promise<void>;
}

interface StationState {
  sim: SimulatorRef;
  nextFireMs: number;
  jitterMs: number;
}

export class ClockAlignedScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly stations = new Map<string, StationState>();

  register(sim: SimulatorRef): void {
    this.stations.set(sim.stationId, {
      sim,
      nextFireMs: 0,
      jitterMs: 0,
    });
  }

  unregister(stationId: string): void {
    this.stations.delete(stationId);
  }

  start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => {
      this.tick();
    }, 1000);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const nowMs = Date.now();

    for (const state of this.stations.values()) {
      if (!state.sim.isConnected) continue;

      const intervalSecs = state.sim.getAlignedIntervalSeconds();
      if (intervalSecs <= 0) continue;

      const intervalMs = intervalSecs * 1000;

      // Compute jitter lazily so it scales with the interval.
      // Spread across 90% of the interval to avoid thundering herd.
      if (state.jitterMs === 0) {
        state.jitterMs = Math.floor(Math.random() * intervalMs * 0.9);
      }

      // Initialize next fire time on first check
      if (state.nextFireMs === 0) {
        const nextBoundary = Math.ceil(nowMs / intervalMs) * intervalMs;
        state.nextFireMs = nextBoundary + state.jitterMs;
      }

      if (nowMs >= state.nextFireMs) {
        // Compute the next clock-aligned boundary
        const nextBoundary = Math.ceil(nowMs / intervalMs) * intervalMs;
        state.nextFireMs = nextBoundary + state.jitterMs;
        // If we just set the same boundary we fired on, push to next
        if (state.nextFireMs <= nowMs) {
          state.nextFireMs += intervalMs;
        }

        state.sim.sendClockAlignedMeterValues().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`[clock-aligned] ${state.sim.stationId} error: ${msg}`);
        });
      }
    }
  }
}
