// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Simulate tab: the High Temperature fault and the Security Event control
// (the OCPP list of the station version grouped by severity, the vendor tamper
// types, the optional tech info) send the simulator actions.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn<(path: string, body: unknown) => Promise<unknown>>(() =>
    Promise.resolve({ commandId: 'c1' }),
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'type' in opts ? `${key}:${String(opts['type'])}` : key,
  }),
}));
vi.mock('@/lib/api', () => ({ api: { post: postMock, get: vi.fn() } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { StationSimulate } from '../StationSimulate';

function renderTab(ocppProtocol: string, isOnline = true): void {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <StationSimulate
        stationId="CS-1"
        evseIds={[1]}
        evses={[{ evseId: 1, connectors: [{ status: 'available' }] }]}
        isOnline={isOnline}
        ocppProtocol={ocppProtocol}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  postMock.mockClear();
});

describe('StationSimulate', () => {
  it('sends the High Temperature fault', async () => {
    renderTab('ocpp2.1');
    fireEvent.change(screen.getByLabelText('simulate.faultType'), {
      target: { value: 'HighTemperature' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'simulate.injectFault' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/css/actions/injectFault', {
        stationId: 'CS-1',
        evseId: 1,
        errorCode: 'HighTemperature',
        mode: 'end',
      });
    });
  });

  it('groups the 2.x security events by severity with plain titles and the vendor types', () => {
    renderTab('ocpp2.1');
    const select = screen.getByLabelText<HTMLSelectElement>('simulate.securityEventType');
    const groups = Array.from(select.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual([
      'severity.critical',
      'severity.high',
      'severity.medium',
      'severity.low',
      'severity.info',
    ]);
    const critical = select.querySelector('optgroup') as HTMLOptGroupElement;
    const values = Array.from(critical.querySelectorAll('option')).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['TamperDetectionActivated', 'TiltDetected']));
    expect(
      within(critical).getByText('simulate.securityEvents.TamperDetectionActivated'),
    ).toBeTruthy();
    expect(Array.from(select.options).map((o) => o.value)).toContain('InvalidCsmsCertificate');
    expect(Array.from(select.options)).toHaveLength(23);
  });

  it('offers the 1.6 whitepaper names to a 1.6 station', () => {
    renderTab('ocpp1.6');
    const values = Array.from(
      screen.getByLabelText<HTMLSelectElement>('simulate.securityEventType').options,
    ).map((o) => o.value);
    expect(values).toContain('InvalidCentralSystemCertificate');
    expect(values).not.toContain('InvalidCsmsCertificate');
    expect(values).toContain('MaintenanceLoginAccepted');
    expect(values).toHaveLength(23);
  });

  it('sends the chosen security event with its tech info', async () => {
    renderTab('ocpp2.0.1');
    fireEvent.change(screen.getByLabelText('simulate.securityEventType'), {
      target: { value: 'TiltDetected' },
    });
    expect(screen.getByText('simulate.securityEventOcppType:TiltDetected')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('simulate.securityEventTechInfo'), {
      target: { value: ' tilt 35 degrees ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'simulate.sendSecurityEvent' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/css/actions/securityEvent', {
        stationId: 'CS-1',
        type: 'TiltDetected',
        techInfo: 'tilt 35 degrees',
      });
    });
  });

  it('sends no tech info when it is empty, and nothing while the station is offline', async () => {
    renderTab('ocpp2.1');
    fireEvent.click(screen.getByRole('button', { name: 'simulate.sendSecurityEvent' }));
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/v1/css/actions/securityEvent', {
        stationId: 'CS-1',
        type: 'TamperDetectionActivated',
      });
    });
    cleanup();
    renderTab('ocpp2.1', false);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'simulate.sendSecurityEvent' })
        .disabled,
    ).toBe(true);
  });
});
