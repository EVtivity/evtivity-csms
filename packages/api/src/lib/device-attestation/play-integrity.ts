// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { GoogleAuth } from 'google-auth-library';

export interface PlayIntegrityConfig {
  packageName: string;
  serviceAccountJson: string;
  cloudProjectNumber: string;
}

export interface PlayIntegrityResult {
  ok: boolean;
}

interface TokenPayloadExternal {
  requestDetails?: {
    requestPackageName?: string;
    nonce?: string;
    timestampMillis?: string;
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    packageName?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
  };
}

// The decode endpoint accepts the integrity token only over a service-account
// credential scoped to playintegrity. The token is single-use and decoded
// server-side; the device never sees the verdict.
const SCOPE = 'https://www.googleapis.com/auth/playintegrity';

// Validates a Google Play Integrity token produced by the Android client for
// the issued challenge. Stateless: no per-device key is stored. Classic request
// flow, so the verdict carries back the nonce we issued.
export async function verifyPlayIntegrity(
  integrityToken: string,
  expectedNonce: string,
  cfg: PlayIntegrityConfig,
): Promise<PlayIntegrityResult> {
  try {
    const credentials = JSON.parse(cfg.serviceAccountJson) as Record<string, unknown>;
    const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
    const client = await auth.getClient();
    const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(
      cfg.packageName,
    )}:decodeIntegrityToken`;
    const res = await client.request<{ tokenPayloadExternal?: TokenPayloadExternal }>({
      url,
      method: 'POST',
      data: { integrity_token: integrityToken },
    });

    const payload = res.data.tokenPayloadExternal;
    if (payload == null) return { ok: false };

    const rd = payload.requestDetails;
    if (rd?.nonce !== expectedNonce) return { ok: false };
    if (rd.requestPackageName !== cfg.packageName) return { ok: false };
    if (payload.appIntegrity?.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return { ok: false };

    const deviceVerdicts = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    if (!deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) return { ok: false };

    return { ok: true };
  } catch {
    return { ok: false };
  }
}
