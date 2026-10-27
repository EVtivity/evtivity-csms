// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { processVersion } from '@evtivity/lib';
import { buildOcppProcessConfig } from '../lib/process-config.js';

const BASE = {
  OCPP_WS_COMPRESSION: true,
  OCPP_MAX_CONNECTIONS_PER_IP: 2500,
  OCPP_MAX_MESSAGES_PER_IP_PER_SECOND: 5000,
  OCPP_MAX_PENDING_AUTH_PER_IP: 50,
  OCPP_TRUSTED_PROXY_CIDRS: '',
};

describe('buildOcppProcessConfig', () => {
  it('reports the settings the process runs with', () => {
    expect(
      buildOcppProcessConfig(BASE, { enabled: false, port: 8443, clientCaConfigured: false }),
    ).toEqual({
      version: processVersion(),
      wsCompression: true,
      tlsEnabled: false,
      tlsPort: null,
      clientCaConfigured: false,
      maxConnectionsPerIp: 2500,
      maxMessagesPerIpPerSecond: 5000,
      maxPendingAuthPerIp: 50,
      trustedProxiesConfigured: false,
    });
  });

  it('reports the TLS port and the proxy list as flags, never the addresses', () => {
    const config = buildOcppProcessConfig(
      { ...BASE, OCPP_WS_COMPRESSION: false, OCPP_TRUSTED_PROXY_CIDRS: ' 10.0.0.0/8 ,' },
      { enabled: true, port: 8443, clientCaConfigured: true },
    );
    expect(config).toMatchObject({
      wsCompression: false,
      tlsEnabled: true,
      tlsPort: 8443,
      clientCaConfigured: true,
      trustedProxiesConfigured: true,
    });
    expect(JSON.stringify(config)).not.toContain('10.0.0.0');
  });

  it('counts a list of blanks as no proxy', () => {
    expect(
      buildOcppProcessConfig(
        { ...BASE, OCPP_TRUSTED_PROXY_CIDRS: ' , ' },
        { enabled: false, port: null, clientCaConfigured: false },
      ).trustedProxiesConfigured,
    ).toBe(false);
  });
});
