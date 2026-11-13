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

  it('opens no stream without a station', () => {
    renderHook(
      () => {
        useStationEvents(undefined);
      },
      { wrapper },
    );
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('opens the public stream of the station and refetches its views on a status event only', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderHook(
      () => {
        useStationEvents('CS-3');
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    const es = FakeEventSource.instances[0];
    if (es == null) throw new Error('no stream');
    expect(es.url.endsWith('/v1/portal/chargers/CS-3/events')).toBe(true);
    const send = (data: string): void => {
      es.onmessage?.({ data } as MessageEvent<string>);
    };
    send(JSON.stringify({ eventType: 'session.updated' }));
    expect(invalidate).not.toHaveBeenCalled();
    send('not json');
    send('42');
    expect(warn).toHaveBeenCalledTimes(2);
    send(JSON.stringify({ eventType: 'station.status' }));
    expect(invalidate.mock.calls.map((c) => c[0]?.queryKey)).toEqual([
      ['station-detail', 'CS-3'],
      ['station-landing', 'CS-3'],
      ['charger-info', 'CS-3'],
      ['charger-pricing', 'CS-3'],
      ['guest-charger-config', 'CS-3'],
    ]);
  });

  it('cancels a pending reopen on unmount and waits for one reopen per close', () => {
    const { unmount } = renderHook(
      () => {
        useStationEvents('CS-4');
      },
      { wrapper },
    );
    const first = FakeEventSource.instances[0];
    if (first == null) throw new Error('no stream');
    first.readyState = FakeEventSource.CLOSED;
    first.onerror?.();
    // A second error while the reopen waits schedules no second one.
    first.onerror?.();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(STATION_EVENTS_RETRY_MS);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
