// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getMock = vi.hoisted(() => vi.fn());
const perms = vi.hoisted(() => ({ payments: true }));
const tableProps = vi.hoisted(() => [] as Record<string, unknown>[]);
const dialogProps = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/auth', () => ({ useHasPermission: () => perms.payments }));
vi.mock('@/lib/timezone', () => ({ useUserTimezone: () => 'UTC' }));
vi.mock('@/components/SessionsTable', () => ({
  SessionsTable: (props: Record<string, unknown>) => {
    tableProps.push(props);
    const sessions = (props.sessions as { id: string }[] | undefined) ?? [];
    const onRowClick = props.onRowClick as (s: { id: string }) => void;
    return (
      <div>
        {sessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              onRowClick(s);
            }}
          >
            {s.id}
          </button>
        ))}
      </div>
    );
  },
}));
vi.mock('@/components/fleet/FleetSessionDialog', () => ({
  FleetSessionDialog: (props: Record<string, unknown>) => {
    dialogProps.push(props);
    return <div>dialog</div>;
  },
}));

import { FleetChargingSessionsWidget } from '../FleetChargingSessionsWidget';

function renderWidget(fleetId: string | null): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <FleetChargingSessionsWidget fleetId={fleetId} />
    </QueryClientProvider>,
  );
}

describe('FleetChargingSessionsWidget', () => {
  afterEach(() => {
    cleanup();
    getMock.mockReset();
    tableProps.length = 0;
    dialogProps.length = 0;
    perms.payments = true;
  });

  it('lists every assigned fleet 20 a page and opens a row in the reduced session view', async () => {
    getMock.mockResolvedValue({
      data: [{ id: 'ses_1', fleetId: 'flt_1', status: 'completed' }],
      total: 1,
    });
    renderWidget(null);
    fireEvent.click(await screen.findByRole('button', { name: 'ses_1' }));
    expect(getMock).toHaveBeenCalledWith('/v1/fleets/dashboard-sessions?page=1&limit=20');
    await waitFor(() => {
      expect(dialogProps.at(-1)).toMatchObject({ fleetId: 'flt_1', sessionId: 'ses_1' });
    });
    const props = tableProps.at(-1) ?? {};
    expect(props.linkEntities).toBe(false);
    expect(props.visibility).toMatchObject({ driverName: false, cost: true });
  });

  it('follows the fleet picker and hides the cost without payments:read', async () => {
    perms.payments = false;
    getMock.mockResolvedValue({ data: [], total: 0 });
    renderWidget('flt_2');
    await waitFor(() => {
      expect(getMock).toHaveBeenCalledWith(
        '/v1/fleets/dashboard-sessions?page=1&limit=20&fleetId=flt_2',
      );
    });
    expect(tableProps.at(-1)?.visibility).toMatchObject({ cost: false });
    expect(tableProps.at(-1)?.emptyMessage).toBe('dashboard.fleet.noChargingSessions');
  });

  it('shows a load error with Retry', async () => {
    getMock.mockRejectedValue(new Error('down'));
    renderWidget(null);
    expect(await screen.findByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
