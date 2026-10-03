// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const REDACTED = '[REDACTED]';

/**
 * Field names that carry secret material, matched case-insensitively so a new
 * credential field (`webhookSecret`, `hubjectClientSecret`, `secretAccessKey`,
 * `apiKey`, `partnerRegistrationToken`) is redacted by its name alone, without
 * an allow-list to keep in sync.
 */
const SECRET_NAME_PATTERN = /password|secret|api_?key|private_?key|access_?key|enc$/i;

/** Bearer-style tokens (`token`, `refreshToken`, `mfaToken`, `rawToken`, ...). */
const TOKEN_NAME_PATTERN = /(^|[a-z])token$/i;

/**
 * Token-named fields that are identifiers, not credentials: the OCPP idToken
 * is the RFID/eMAID shown across the operator UI and in the authorize log.
 */
const NON_SECRET_TOKEN_NAMES = new Set(['idToken']);

/** One-time codes and certificates (PEM bodies may carry private keys). */
const SECRET_EXACT_NAMES = new Set(['code', 'certificate']);

const MAX_DEPTH = 8;

function isSecretName(name: string): boolean {
  if (SECRET_EXACT_NAMES.has(name)) return true;
  if (SECRET_NAME_PATTERN.test(name)) return true;
  return TOKEN_NAME_PATTERN.test(name) && !NON_SECRET_TOKEN_NAMES.has(name);
}

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value == null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretName(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * The request body as stored in the access log, with secret fields replaced
 * by `[REDACTED]` at any depth. On `/v1/settings/<key>` the `value` is
 * redacted too: the key name alone says what changed, and a `*Enc` value is
 * plaintext on the wire (encrypted only at rest, Principle 12).
 */
export function redactAccessLogBody(
  path: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = redact(body, 0) as Record<string, unknown>;
  if (path.startsWith('/v1/settings/') && 'value' in sanitized) {
    sanitized['value'] = REDACTED;
  }
  return sanitized;
}
