// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The payload of an EPC QR code (EPC069-12, "Quick Response Code: Guidelines
 * to Enable Data Capture for the Initiation of a SEPA Credit Transfer"),
 * version 002: banking apps read it to prefill a SEPA credit transfer. Pure,
 * browser-safe.
 */

/** Longest beneficiary name (field 6). */
export const EPC_MAX_NAME_LENGTH = 70;
/** Longest unstructured remittance information (field 11). */
export const EPC_MAX_REMITTANCE_LENGTH = 140;
/** Highest amount in cents: EUR 999999999.99 (field 8). */
export const EPC_MAX_AMOUNT_CENTS = 99_999_999_999;
/** Longest payload in bytes. */
export const EPC_MAX_PAYLOAD_BYTES = 331;

export interface EpcQrInput {
  /** The beneficiary name; cut to 70 characters. */
  name: string;
  /** The IBAN without spaces. */
  iban: string;
  /** The BIC; optional in version 002 (empty or null leaves the line empty). */
  bic: string | null;
  /** The amount to transfer, in cents. */
  amountCents: number;
  /** ISO 4217 code; the code is for SEPA credit transfers in EUR only. */
  currency: string;
  /** Unstructured remittance information (the invoice number); cut to 140 characters. */
  remittance: string;
}

/**
 * The EPC QR payload, lines separated by LF: service tag `BCD`, version
 * `002`, character set `1` (UTF-8), identification `SCT`, BIC, name, IBAN,
 * amount `EUR<amount>` with two decimals, an empty purpose, an empty
 * structured reference, and the unstructured remittance (the last line, no
 * trailing LF). Null when the currency is not EUR, the amount is not from
 * EUR 0.01 to EUR 999999999.99, the name or IBAN is empty, or the payload
 * exceeds 331 bytes.
 */
export function buildEpcQrPayload(input: EpcQrInput): string | null {
  if (input.currency.toUpperCase() !== 'EUR') return null;
  if (!Number.isInteger(input.amountCents)) return null;
  if (input.amountCents < 1 || input.amountCents > EPC_MAX_AMOUNT_CENTS) return null;
  const name = oneLine(input.name).slice(0, EPC_MAX_NAME_LENGTH);
  const iban = input.iban.replace(/\s+/g, '').toUpperCase();
  if (name === '' || iban === '') return null;
  const bic = (input.bic ?? '').replace(/\s+/g, '').toUpperCase();
  const remittance = oneLine(input.remittance).slice(0, EPC_MAX_REMITTANCE_LENGTH);
  const amount = `EUR${(input.amountCents / 100).toFixed(2)}`;
  const payload = ['BCD', '002', '1', 'SCT', bic, name, iban, amount, '', '', remittance].join(
    '\n',
  );
  if (new TextEncoder().encode(payload).length > EPC_MAX_PAYLOAD_BYTES) return null;
  return payload;
}

/** Trimmed, with line breaks and other control characters replaced by spaces. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
}
