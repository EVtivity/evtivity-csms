// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Firmware campaign download and install settings, and the UpdateFirmware
// request a campaign sends. Browser-safe: the CSMS form uses the limits.

/** Most download retries a campaign asks for (UpdateFirmware `retries`, 0 means none). */
export const FIRMWARE_RETRIES_MAX = 100;
/** Longest wait between download retries, in seconds (UpdateFirmware `retryInterval`). */
export const FIRMWARE_RETRY_INTERVAL_MAX_SECONDS = 86_400;

export interface FirmwareCampaignCommandSource {
  firmwareUrl: string;
  signingCertificate: string | null;
  signature: string | null;
  retries: number | null;
  retryInterval: number | null;
  installDateTime: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The OCPP 2.1 UpdateFirmware request of a campaign for one station. The OCPP
 * server sends it to a 1.6 station as UpdateFirmware (location, retrieveDate,
 * retries, retryInterval; 1.6 has no install time) or, when signed, as
 * SignedUpdateFirmware (the same shape as 2.1).
 */
export function buildCampaignUpdateFirmware(
  campaign: FirmwareCampaignCommandSource,
  requestId: number,
  retrieveDateTime: Date,
): Record<string, unknown> {
  return {
    requestId,
    ...(campaign.retries != null ? { retries: campaign.retries } : {}),
    ...(campaign.retryInterval != null ? { retryInterval: campaign.retryInterval } : {}),
    firmware: {
      location: campaign.firmwareUrl,
      retrieveDateTime: retrieveDateTime.toISOString(),
      ...(campaign.installDateTime != null
        ? { installDateTime: toIso(campaign.installDateTime) }
        : {}),
      // Secure firmware update (L01.FR.11).
      ...(campaign.signingCertificate != null && campaign.signature != null
        ? { signingCertificate: campaign.signingCertificate, signature: campaign.signature }
        : {}),
    },
  };
}
