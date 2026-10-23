// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

const { useStationEvents, STATION_EVENTS_RETRY_MS } = await import('../use-station-events');

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useStationEvents', () => {
  it('opens a new stream after a refused one (429 closes an EventSource for good)', () => {
    const { unmount } = renderHook(
      () => {
        useStationEvents('CS-1');
      },
      { wrapper },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    if (first == null) throw new Error('no stream');
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    vi.advanceTimersByTime(STATION_EVENTS_RETRY_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    unmount();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });

  it('leaves a dropped stream to the browser reconnect, and retries nothing after unmount', () => {
    const { unmount } = renderHook(
      () => {
        useStationEvents('CS-2');
      },
      { wrapper },
    );
    const first = FakeEventSource.instances[0];
    if (first == null) throw new Error('no stream');
    first.readyState = FakeEventSource.CONNECTING;
    first.onerror?.();
    vi.advanceTimersByTime(STATION_EVENTS_RETRY_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    unmount();
    vi.advanceTimersByTime(STATION_EVENTS_RETRY_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
