// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { processVersion } from '@evtivity/lib';
import type { OcppProcessConfig } from '@evtivity/database';
import type { OcppConfig } from './config.js';

/**
 * The settings this OCPP process reports in its `ocpp_server_health` row, so
 * System Information shows what each process runs with (Helm and CDK give
 * every service its own environment). Flags only, never a secret or a PEM.
 */
export function buildOcppProcessConfig(
  config: Pick<
    OcppConfig,
    | 'OCPP_WS_COMPRESSION'
    | 'OCPP_MAX_CONNECTIONS_PER_IP'
    | 'OCPP_MAX_MESSAGES_PER_IP_PER_SECOND'
    | 'OCPP_MAX_PENDING_AUTH_PER_IP'
    | 'OCPP_TRUSTED_PROXY_CIDRS'
  >,
  tls: { enabled: boolean; port: number | null; clientCaConfigured: boolean },
): OcppProcessConfig {
  return {
    version: processVersion(),
    wsCompression: config.OCPP_WS_COMPRESSION,
    tlsEnabled: tls.enabled,
    tlsPort: tls.enabled ? tls.port : null,
    clientCaConfigured: tls.clientCaConfigured,
    maxConnectionsPerIp: config.OCPP_MAX_CONNECTIONS_PER_IP,
    maxMessagesPerIpPerSecond: config.OCPP_MAX_MESSAGES_PER_IP_PER_SECOND,
    maxPendingAuthPerIp: config.OCPP_MAX_PENDING_AUTH_PER_IP,
    trustedProxiesConfigured: config.OCPP_TRUSTED_PROXY_CIDRS.split(',').some(
      (entry) => entry.trim() !== '',
    ),
  };
}
