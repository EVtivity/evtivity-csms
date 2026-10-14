// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// ISO 15118 Plug and Charge over OCPP 1.6, per the Open Charge Alliance
// application note "Using ISO 15118 Plug & Charge with OCPP 1.6" (v1.0,
// 2020-09-16): the OCPP 2.0.1 certificate and authorization messages travel in
// DataTransfer with a fixed vendorId, the message name in messageId and the
// message itself as a JSON string in data (section 2.2). The answer is wrapped
// the same way in the DataTransfer.conf data. Shared by the OCPP server and the
// station simulator.

/** The fixed DataTransfer vendorId of the application note (2.2). */
export const PNC16_VENDOR_ID = 'org.openchargealliance.iso15118pnc';

/** The messageIds the application note defines (2.2). */
export const PNC16_MESSAGE_IDS = [
  'Authorize',
  'CertificateSigned',
  'DeleteCertificate',
  'Get15118EVCertificate',
  'GetCertificateStatus',
  'GetInstalledCertificateIds',
  'InstallCertificate',
  'SignCertificate',
  'TriggerMessage',
] as const;

export type Pnc16MessageId = (typeof PNC16_MESSAGE_IDS)[number];

export function isPnc16MessageId(value: unknown): value is Pnc16MessageId {
  return typeof value === 'string' && (PNC16_MESSAGE_IDS as readonly string[]).includes(value);
}

/** DataTransfer.req payload carrying one application note message. */
export function wrapPnc16(
  messageId: Pnc16MessageId,
  message: Record<string, unknown>,
): { vendorId: string; messageId: string; data: string } {
  return { vendorId: PNC16_VENDOR_ID, messageId, data: JSON.stringify(message) };
}

/**
 * The message a DataTransfer (request or answer) carries in `data`: a JSON
 * object, or null when `data` is missing or is not a JSON object.
 */
export function unwrapPnc16Data(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // fail-open: data that is not JSON carries no message; the caller answers it as such
    return null;
  }
}

/**
 * The wrapped answer of a DataTransfer.conf: the message in `data` when the
 * station accepted the DataTransfer, else null (Rejected, UnknownVendorId,
 * UnknownMessageId, or no message).
 */
export function unwrapPnc16Answer(
  response: Record<string, unknown>,
): Record<string, unknown> | null {
  if (response['status'] !== 'Accepted') return null;
  return unwrapPnc16Data(response['data']);
}
