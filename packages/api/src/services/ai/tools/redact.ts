// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Tool result redactor. Every tool result passes through `redactToolValue`
 * before it reaches the model, the client or the database:
 *
 * 1. Keys: a string or number field whose name is secret-shaped
 *    (`isSecretShapedKey`) is dropped.
 * 2. Values: secrets inside any string (JWTs, PEM blocks, provider and
 *    payment keys, AWS key ids, bearer tokens, long hex after a key-like
 *    label) are masked.
 * 3. Personal data: card numbers (Luhn-checked) and IBANs are masked on every
 *    surface. On the support surface, whose output can reach a driver, email
 *    addresses and phone numbers are partly masked and `idToken` values are
 *    replaced by a short hash.
 *
 * The second layer is the schema gate: the tool codegen and TC-AI-R-01 fail
 * when an exposed tool's response schema has a secret-shaped field.
 */

import { createHash } from 'node:crypto';
import type { AiSurface } from './policy.js';

export interface RedactionCounts {
  /** Fields dropped because of a secret-shaped name. */
  keys: number;
  /** Secret values masked inside strings. */
  values: number;
  /** Personal data masked. */
  pii: number;
}

export const REDACTED = '[redacted]';

/** Secret-shaped names, compared lowercased without `_`, `-` and `.`. */
const SECRET_KEY_SUFFIX =
  /(password|passwd|passphrase|secret|token|tokens|(?:api|private|client|secret|hmac|signing|encryption|access|auth|authorization|master|license)key|accesskeyid|clientcert|hmac|hash|enc|credential|credentials|signature|otp|totp|seed|salt|cookie|authorization)$/;

/** Names that look secret but are not, with the reason. */
const NOT_SECRET_KEYS: Readonly<Record<string, string>> = {
  tokentype: 'enum',
  maxtokens: 'a count',
};

/** A boolean flag about a secret (`hasPassword`, `mustResetPassword`), not the secret. */
const FLAG_PREFIX = /^(has|is|must|needs|should)[A-Z_]/;

/**
 * A driver token identifier (`idToken`, `tokenIdToken`, `groupIdToken`): an
 * RFID uid or eMAID, personal data rather than a secret. Hashed on the
 * support surface.
 */
function isIdTokenKey(normalized: string): boolean {
  return normalized.endsWith('idtoken');
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-.]/g, '');
}

/** Whether a field name marks a secret (`smtp.passwordEnc`, `api_key`, `webhookSecret`, `tokenHash`). */
export function isSecretShapedKey(key: string): boolean {
  if (FLAG_PREFIX.test(key)) return false;
  const k = normalizeKey(key);
  if (Object.prototype.hasOwnProperty.call(NOT_SECRET_KEYS, k) || isIdTokenKey(k)) return false;
  return SECRET_KEY_SUFFIX.test(k);
}

/** Secret shapes inside strings, each masked whole. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
];

/** Long hex after a key-like label (`secret: 9f86d0...`); the label is kept. */
const LABELLED_HEX_PATTERN =
  /\b((?:key|secret|token|signature|hmac|password)["']?\s*[:=]\s*["']?)[0-9a-fA-F]{32,}/gi;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A card number written in groups (`4242 4242 4242 4242`); ids and timestamps are not grouped. */
const GROUPED_CARD_PATTERN = /\b\d{4}(?:[ -]\d{4}){2}[ -]\d{1,7}\b/g;
/** A field that holds a card number, where contiguous digits are checked too. */
/** ISO 13616 check digits (mod 97), so ids that only look like an IBAN stay. */
function ibanValid(candidate: string): boolean {
  const iban = candidate.replace(/ /g, '');
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const CARD_KEYS = /(cardnumber|pan|primaryaccountnumber)$/;
const IBAN_PATTERN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;
const EMAIL_PATTERN = /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PHONE_KEYS = /(phone|phonenumber|mobile|mobilenumber|tel|telephone|msisdn)$/;

function maskTail(value: string, keep: number): string {
  const tail = value.replace(/[^A-Za-z0-9]/g, '').slice(-keep);
  return `****${tail}`;
}

interface Walk {
  surface: AiSurface;
  counts: RedactionCounts;
}

function maskCard(match: string, w: Walk): string {
  const digits = match.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
  w.counts.pii++;
  return maskTail(digits, 4);
}

function redactString(input: string, w: Walk): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, () => {
      w.counts.values++;
      return REDACTED;
    });
  }
  out = out.replace(LABELLED_HEX_PATTERN, (_match, label: string) => {
    w.counts.values++;
    return `${label}${REDACTED}`;
  });
  out = out.replace(GROUPED_CARD_PATTERN, (match) => maskCard(match, w));
  out = out.replace(IBAN_PATTERN, (match) => {
    if (!ibanValid(match)) return match;
    w.counts.pii++;
    return maskTail(match, 4);
  });
  if (w.surface === 'support') {
    out = out.replace(EMAIL_PATTERN, (_match, first: string, domain: string) => {
      w.counts.pii++;
      return `${first}***@${domain}`;
    });
  }
  return out;
}

function hashIdToken(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function redactNode(value: unknown, key: string | null, w: Walk): unknown {
  if (typeof value === 'string') {
    if (key != null && CARD_KEYS.test(normalizeKey(key)) && /^[\d -]+$/.test(value)) {
      return maskCard(value, w);
    }
    if (key != null && w.surface === 'support') {
      const k = normalizeKey(key);
      if (isIdTokenKey(k) && value !== '') {
        w.counts.pii++;
        return hashIdToken(value);
      }
      if (PHONE_KEYS.test(k) && value !== '') {
        w.counts.pii++;
        return maskTail(value, 4);
      }
    }
    return redactString(value, w);
  }
  if (Array.isArray(value)) return value.map((item) => redactNode(item, key, w));
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A secret is a scalar: an object under a secret-shaped name (a
      // session's `token` object) is walked, a boolean flag is kept.
      if (isSecretShapedKey(k) && (typeof v === 'string' || typeof v === 'number')) {
        w.counts.keys++;
        continue;
      }
      out[k] = redactNode(v, k, w);
    }
    return out;
  }
  return value;
}

export function emptyRedactionCounts(): RedactionCounts {
  return { keys: 0, values: 0, pii: 0 };
}

/** Redacts a parsed tool result (or tool arguments) for `surface`. Never mutates `value`. */
export function redactToolValue(
  value: unknown,
  surface: AiSurface,
): { value: unknown; counts: RedactionCounts } {
  const w: Walk = { surface, counts: emptyRedactionCounts() };
  return { value: redactNode(value, null, w), counts: w.counts };
}

/** Redacts free text (a non-JSON tool result, an error body). */
export function redactToolText(
  text: string,
  surface: AiSurface,
): { text: string; counts: RedactionCounts } {
  const w: Walk = { surface, counts: emptyRedactionCounts() };
  return { text: redactString(text, w), counts: w.counts };
}
