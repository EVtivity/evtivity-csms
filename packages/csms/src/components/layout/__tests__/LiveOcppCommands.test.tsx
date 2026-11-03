// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ api: { get: apiGet } }));

const permissions = vi.hoisted(() => ({ list: ['stations:read'] as string[] }));
vi.mock('@/lib/auth', () => ({
  useHasPermission: (perm: string) => permissions.list.includes(perm),
}));

vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (at: string) => new Date(at).toISOString().slice(11, 19),
}));

import { LiveOcppButton, LiveOcppWindow, useCanViewLiveOcpp } from '../LiveOcppCommands';
import { LIVE_OCPP_HISTORY, LIVE_OCPP_POLL_MS } from '../live-ocpp-buffer';

const SITE = 'sit_aaaaaaaaaaaa';

function line(id: number, at: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    stationId: 'sta_aaaaaaaaaaaa',
    stationOcppId: 'CS-3050',
    direction: 'inbound',
    messageType: 2,
    messageId: `m${String(id)}`,
    action: 'Heartbeat',
    payload: {},
    errorCode: null,
    errorDescription: null,
    createdAt: at,
    ...overrides,
  };
}

const POWER = {
  eventType: 'Updated',
  meterValue: [
    {
      sampledValue: [
        { value: 7200, measurand: 'Power.Active.Import', unitOfMeasure: { unit: 'W' } },
      ],
    },
  ],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiGet.mockReset();
  permissions.list = ['stations:read'];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LiveOcppWindow', () => {
  it('loads the recent history of the site, then polls from the newest line', async () => {
    apiGet
      .mockResolvedValueOnce({
        data: [
          line(1, '2026-11-03T14:02:10Z'),
          line(2, '2026-11-03T14:02:11Z', { action: 'TransactionEvent', payload: POWER }),
        ],
      })
      .mockResolvedValue({ data: [] });
    render(<LiveOcppWindow siteId={SITE} focusStation={null} onClose={vi.fn()} />);

    await screen.findByTestId('live-ocpp-line-2');
    expect(apiGet.mock.calls[0]?.[0]).toBe(
      `/v1/sites/${SITE}/ocpp-messages?limit=${String(LIVE_OCPP_HISTORY)}`,
    );
    expect(screen.getByTestId('live-ocpp-line-2').textContent).toContain(
      '14:02:11CS-3050>sites.layoutView.liveOcpp.fromStationTransactionEventUpdated 7.2 kW',
    );
    expect(screen.getByTestId('live-ocpp-line-1').getAttribute('data-dim')).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_OCPP_POLL_MS);
    });
    const next = String(apiGet.mock.calls[1]?.[0]);
    expect(next).toContain('after=2026-11-03T14%3A02%3A06.000Z');
  });

  it('expands a line to its payload', async () => {
    apiGet.mockResolvedValue({
      data: [
        line(3, '2026-11-03T14:02:11Z', {
          action: 'Reset',
          direction: 'outbound',
          payload: { type: 'OnIdle' },
        }),
      ],
    });
    render(<LiveOcppWindow siteId={SITE} focusStation={null} onClose={vi.fn()} />);
    const row = await screen.findByTestId('live-ocpp-line-3');
    const button = row.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('live-ocpp-detail').textContent).toContain('"OnIdle"');
  });

  it('filters to the station picked in the view and goes back to all stations', async () => {
    apiGet.mockResolvedValue({ data: [] });
    const { rerender } = render(
      <LiveOcppWindow siteId={SITE} focusStation={null} onClose={vi.fn()} />,
    );
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalled();
    });
    rerender(
      <LiveOcppWindow
        siteId={SITE}
        focusStation={{ id: 'sta_bbbbbbbbbbbb', stationId: 'CS-9' }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(String(apiGet.mock.lastCall?.[0])).toContain('stationId=sta_bbbbbbbbbbbb');
    });
    fireEvent.click(screen.getByTestId('live-ocpp-all-stations'));
    await waitFor(() => {
      expect(String(apiGet.mock.lastCall?.[0])).not.toContain('stationId=');
    });
    expect(screen.queryByTestId('live-ocpp-all-stations')).toBeNull();
  });

  it('stops polling while paused and empties on Clear', async () => {
    apiGet.mockResolvedValue({ data: [line(5, '2026-11-03T14:02:11Z')] });
    render(<LiveOcppWindow siteId={SITE} focusStation={null} onClose={vi.fn()} />);
    await screen.findByTestId('live-ocpp-line-5');
    fireEvent.click(screen.getByTestId('live-ocpp-pause'));
    const calls = apiGet.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_OCPP_POLL_MS * 3);
    });
    expect(apiGet.mock.calls.length).toBe(calls);
    fireEvent.click(screen.getByTestId('live-ocpp-clear'));
    expect(screen.queryByTestId('live-ocpp-line-5')).toBeNull();
    // A line the user cleared does not come back with the next poll.
    fireEvent.click(screen.getByTestId('live-ocpp-pause'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_OCPP_POLL_MS);
    });
    expect(apiGet.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.queryByTestId('live-ocpp-line-5')).toBeNull();
  });

  it('says when loading fails and keeps retrying', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    apiGet.mockRejectedValue(new Error('down'));
    render(<LiveOcppWindow siteId={SITE} focusStation={null} onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'sites.layoutView.liveOcpp.loadError',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_OCPP_POLL_MS);
    });
    expect(apiGet.mock.calls.length).toBeGreaterThan(1);
    warn.mockRestore();
  });

  it('closes from its close button', async () => {
    apiGet.mockResolvedValue({ data: [] });
    const onClose = vi.fn();
    render(<LiveOcppWindow siteId={SITE} focusStation={null} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('live-ocpp-close'));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalled();
    });
  });
});

describe('LiveOcppButton and its permission', () => {
  function Probe(): React.JSX.Element {
    return <span data-testid="can">{String(useCanViewLiveOcpp())}</span>;
  }

  it('needs the station OCPP log permission', () => {
    render(<Probe />);
    expect(screen.getByTestId('can').textContent).toBe('true');
    cleanup();
    permissions.list = ['sites:read'];
    render(<Probe />);
    expect(screen.getByTestId('can').textContent).toBe('false');
  });

  it('shows its pressed state', () => {
    const onToggle = vi.fn();
    render(<LiveOcppButton open onToggle={onToggle} />);
    const button = screen.getByTestId('live-ocpp-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('sites.layoutView.liveOcpp.button');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });
});
