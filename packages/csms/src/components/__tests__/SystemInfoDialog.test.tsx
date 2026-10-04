// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

import { SystemInfoDialog } from '../SystemInfoDialog';

function info(payments: { provider: string; configured: boolean }): Record<string, unknown> {
  return {
    version: '0.1.38',
    nodeEnv: 'test',
    logLevel: 'info',
    network: {
      bindIp: null,
      apiPort: '7102',
      apiHost: '0.0.0.0',
      ocppPort: '7103',
      ocppHost: '0.0.0.0',
      ocppHealthPort: '8081',
      ocppTlsPort: null,
      ocppTlsEnabled: false,
      ocpiPort: null,
      ocpiHost: null,
      metricsPort: '9091',
      csmsUrl: null,
      portalUrl: null,
      cookieDomain: null,
      corsOrigin: '*',
    },
    rateLimits: {
      rateLimitMax: '3000',
      rateLimitWindow: '1 minute',
      authRateLimitMax: '30',
      ocppMaxConnectionsPerIp: null,
      ocppMaxMessagesPerIpPerSecond: null,
    },
    ocpp: { instanceId: null, registrationPolicy: 'approval-required' },
    ocpi: { baseUrl: null, countryCode: 'US', partyId: 'EVT', businessName: null },
    simulator: { mode: 'standby', actionIntervalMs: null, stationLimit: null },
    seed: { seedDemo: 'false' },
    payments,
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
    },
  };
}

function renderDialog(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SystemInfoDialog open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
});

function rowValue(label: string): string {
  const row = screen.getByText(label).parentElement;
  return row?.textContent.slice(label.length) ?? '';
}

describe('SystemInfoDialog payments', () => {
  it('shows the selected provider, whether it is ready, and the Adyen credentials', async () => {
    getMock.mockResolvedValue(info({ provider: 'adyen', configured: true }));
    renderDialog();
    expect(await screen.findByText('paymentProviders.systemInfo.title')).toBeTruthy();
    expect(rowValue('payments.provider')).toBe('adyen');
    expect(rowValue('paymentProviders.systemInfo.providerStatus')).toBe('Configured');
    expect(rowValue('Adyen')).toBe('Configured');
    expect(rowValue('Stripe')).toBe('Not set');
  });

  it('shows none without a status row when payments are off', async () => {
    getMock.mockResolvedValue(info({ provider: 'none', configured: false }));
    renderDialog();
    await screen.findByText('paymentProviders.systemInfo.title');
    expect(rowValue('payments.provider')).toBe('none');
    expect(screen.queryByText('paymentProviders.systemInfo.providerStatus')).toBeNull();
  });
});
