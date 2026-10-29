// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));
vi.mock('@/lib/timezone', () => ({
  useUserTimezone: () => 'UTC',
  formatDateTime: (value: string) => value,
}));

import { SystemInfoDialog } from '../SystemInfoDialog';

const PROCESS_CONFIG = {
  version: '0.1.48',
  wsCompression: true,
  tlsEnabled: true,
  tlsPort: 8443,
  clientCaConfigured: false,
  maxConnectionsPerIp: 2500,
  maxMessagesPerIpPerSecond: 5000,
  maxPendingAuthPerIp: 50,
  trustedProxiesConfigured: false,
};

function info(
  payments: { provider: string; configured: boolean },
  bindIp: string | null = null,
): Record<string, unknown> {
  return {
    version: '0.1.48',
    nodeEnv: 'test',
    logLevel: 'info',
    network: {
      bindIp,
      apiPort: '7102',
      apiHost: '0.0.0.0',
      ocppStationTlsUrl: null,
      ocpiPort: null,
      ocpiHost: null,
      metricsPort: '9091',
      csmsUrl: 'http://localhost:7100',
      portalUrl: 'http://localhost:7101',
      cookieDomain: null,
      corsOrigin: '*',
    },
    rateLimits: {
      rateLimitMax: '3000',
      rateLimitWindow: '1 minute',
      authRateLimitMax: '30',
      authRateLimitWindow: '1 minute',
    },
    security: { trustProxyConfigured: false, webauthnRpId: null, sharedRateLimit: true },
    ocpp: { registrationPolicy: 'approval-required' },
    ocppProcesses: [
      {
        instanceId: 'ocpp-a',
        connectedStations: 12,
        serverStartedAt: '2026-10-26T08:00:00.000Z',
        updatedAt: '2026-10-26T09:00:00.000Z',
        config: PROCESS_CONFIG,
      },
      {
        instanceId: 'ocpp-old',
        connectedStations: 3,
        serverStartedAt: '2026-10-26T07:00:00.000Z',
        updatedAt: '2026-10-26T09:00:00.000Z',
        config: null,
      },
    ],
    ocpi: { baseUrl: null, countryCode: 'US', partyId: 'EVT', businessName: null },
    simulator: { mode: 'standby', actionIntervalMs: null, stationLimit: null, stationCount: 0 },
    seed: { seedDemo: 'false' },
    payments,
    simProviders: {
      hologram: { enabled: true, configured: false },
      '1nce': { enabled: false, configured: true },
      sessionsFetchDays: 7,
      stationSignalEnabled: false,
    },
    dataPlans: {
      stations: { wifiOrWired: 5, cellular: 2 },
      sites: { wifiOrWired: 0, cellular: 1 },
    },
    secrets: {
      jwtConfigured: true,
      settingsEncryptionConfigured: true,
      stripeConfigured: false,
      adyenConfigured: true,
      smtpConfigured: false,
      twilioConfigured: false,
      s3Configured: false,
      recaptchaConfigured: false,
      hubjectConfigured: false,
      googleMapsConfigured: false,
      webhookSigningConfigured: true,
      simHologramConfigured: false,
      simOneNceConfigured: true,
    },
  };
}

function renderDialog(onOpenChange: (open: boolean) => void = () => undefined): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SystemInfoDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

function rowValue(label: string, scope: HTMLElement = document.body): string {
  const cell = within(scope).getByText(label);
  return cell.nextElementSibling?.textContent ?? '';
}

describe('SystemInfoDialog payments', () => {
  it('shows the selected provider, whether it is ready, and the Adyen credentials', async () => {
    getMock.mockResolvedValue(info({ provider: 'adyen', configured: true }));
    renderDialog();
    expect(await screen.findByTestId('system-info-section-payments')).toBeTruthy();
    expect(rowValue('payments.provider')).toBe('adyen');
    expect(rowValue('paymentProviders.systemInfo.providerStatus')).toBe('systemInfo.configured');
    expect(rowValue('Adyen')).toBe('systemInfo.configured');
    expect(rowValue('Stripe')).toBe('systemInfo.notSet');
  });

  it('shows none without a status row when payments are off', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    await screen.findByTestId('system-info-section-payments');
    expect(rowValue('payments.provider')).toBe('none');
    expect(screen.queryByText('paymentProviders.systemInfo.providerStatus')).toBeNull();
  });
});

describe('SystemInfoDialog bind address', () => {
  it('shows BIND_IP on a Docker Compose install', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }, '192.168.1.234'));
    renderDialog();
    await screen.findByTestId('system-info-section-network');
    expect(rowValue('BIND_IP')).toBe('192.168.1.234');
  });

  it('hides BIND_IP outside Docker Compose', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    await screen.findByTestId('system-info-section-network');
    expect(screen.queryByText('BIND_IP')).toBeNull();
  });
});

describe('SystemInfoDialog OCPP processes', () => {
  it('lists the settings of each process, and Not Reported for an older one', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    const section = await screen.findByTestId('system-info-section-ocppProcesses');
    const groups = within(section).getAllByTestId('system-info-group');
    expect(groups.map((g) => g.textContent)).toEqual(['ocpp-a', 'ocpp-old']);
    const first = groups[0]?.parentElement as HTMLElement;
    const second = groups[1]?.parentElement as HTMLElement;
    expect(rowValue('OCPP_MAX_PENDING_AUTH_PER_IP', first)).toBe('50');
    expect(rowValue('OCPP_TLS_PORT', first)).toBe('8443');
    expect(rowValue('systemInfo.connectedStations', first)).toBe('12');
    expect(rowValue('systemInfo.settings', second)).toBe('systemInfo.notReported');
    expect(within(second).queryByText('OCPP_TLS_PORT')).toBeNull();
  });

  it('shows the SIM provider and data plan sections', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    const sim = await screen.findByTestId('system-info-section-simProviders');
    expect(rowValue('sim.hologram.enabled', sim)).toBe('systemInfo.enabled');
    expect(rowValue('Hologram', sim)).toBe('systemInfo.notSet');
    expect(rowValue('sim.1nce.enabled', sim)).toBe('systemInfo.disabled');
    expect(rowValue('1NCE', sim)).toBe('systemInfo.configured');
    const plans = screen.getByTestId('system-info-section-dataPlans');
    expect(rowValue('systemInfo.stationsCellular', plans)).toBe('2');
    expect(rowValue('systemInfo.sitesCellular', plans)).toBe('1');
  });
});

describe('SystemInfoDialog search and section filter', () => {
  it('narrows the rows by label or value, case-insensitive, and says when nothing matches', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    await screen.findByTestId('system-info-section-network');
    fireEvent.change(screen.getByPlaceholderText('systemInfo.search'), {
      target: { value: 'cors_origin' },
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('system-info-row')).toHaveLength(1);
    });
    expect(screen.getByText('CORS_ORIGIN')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('systemInfo.search'), {
      target: { value: 'ocpp-old' },
    });
    await waitFor(() => {
      expect(screen.getByText('systemInfo.notReported')).toBeTruthy();
    });
    expect(screen.queryByText('ocpp-a')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('systemInfo.search'), {
      target: { value: 'zzz-nothing' },
    });
    expect(await screen.findByTestId('system-info-no-matches')).toBeTruthy();
  });

  it('shows one section when one is picked', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    await screen.findByTestId('system-info-section-network');
    fireEvent.change(screen.getByLabelText('systemInfo.section'), {
      target: { value: 'security' },
    });
    expect(screen.getByTestId('system-info-section-security')).toBeTruthy();
    expect(screen.queryByTestId('system-info-section-network')).toBeNull();
    expect(rowValue('systemInfo.sharedRateLimit')).toBe('systemInfo.enabled');
  });

  it('closes from the footer', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    await screen.findByTestId('system-info-section-network');
    fireEvent.click(screen.getAllByText('common.close').at(-1) as HTMLElement);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
