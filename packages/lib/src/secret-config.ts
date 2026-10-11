// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Credential names in configuration data and OCPP payloads. One rule shared
 * by the AI redactor (`@evtivity/ai/redact`) and the OCPP message log
 * (`maskStationCredentials`), so a station password never reaches either.
 * Browser-safe.
 *
 * A credential name ends in password, passphrase, secret, an auth, API or
 * private key, `Enc`, or credential, compared lowercased without `_`, `-`
 * and `.`: `BasicAuthPassword` (OCPP 2.1 SecurityCtrlr), `AuthorizationKey`
 * (OCPP 1.6), `basicAuthPassword` (SetNetworkProfile connectionData),
 * `smtp.passwordEnc` (a settings row). Narrower than the AI redactor's field
 * rule: `LocalPreAuthorization`, `issuerKeyHash` or a site called "Basalt"
 * hold no secret.
 */

/** The text a masked value is replaced with. */
export const REDACTED = '[redacted]';

/** A boolean flag about a secret (`hasPassword`, `mustResetPassword`), not the secret. */
export const SECRET_FLAG_PREFIX = /^(has|is|must|needs|should)[A-Z_]/;

const CREDENTIAL_SUFFIX =
  /(password|passwd|passphrase|secret|(?:api|private|client|secret|hmac|signing|encryption|access|auth|authorization|master)key|accesskeyid|enc|credential|credentials)$/;

/** One word, no spaces: a field, configuration key or variable name. */
const NAME = /^[A-Za-z0-9_.-]+$/;

/** The value fields of a configuration entry (`{ key, value }`, `{ variable, attributeValue }`). */
const CONFIG_VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'attributevalue']);
/** The list of values of an OCPP 2.1 reported variable (`variableAttribute[].value`). */
const CONFIG_ATTRIBUTE_LIST = 'variableattribute';

/** Lowercase without `_`, `-` and `.`, the form every name rule compares. */
export function normalizeSecretName(name: string): string {
  return name.toLowerCase().replace(/[_\-.]/g, '');
}

/** Whether a name (a field, configuration key or variable) names a credential. */
export function isCredentialName(name: unknown): boolean {
  return (
    typeof name === 'string' &&
    NAME.test(name) &&
    !SECRET_FLAG_PREFIX.test(name) &&
    CREDENTIAL_SUFFIX.test(normalizeSecretName(name))
  );
}

/**
 * Whether an object is a configuration entry or variable named as a
 * credential: `{ key: 'AuthorizationKey', value }`, `{ name, value }`, or
 * `{ variable: { name: 'BasicAuthPassword' }, attributeValue }`.
 */
export function isSecretConfigEntry(obj: Record<string, unknown>): boolean {
  const variable = obj['variable'];
  return (
    isCredentialName(obj['key']) ||
    isCredentialName(obj['name']) ||
    (variable != null &&
      typeof variable === 'object' &&
      isCredentialName((variable as Record<string, unknown>)['name']))
  );
}

/** Whether a field holds the value of a configuration entry (`value`, `attributeValue`). */
export function isConfigValueKey(key: string): boolean {
  return CONFIG_VALUE_KEYS.has(normalizeSecretName(key));
}

/** Whether a field is the `variableAttribute` list of a reported variable. */
export function isConfigAttributeList(key: string): boolean {
  return normalizeSecretName(key) === CONFIG_ATTRIBUTE_LIST;
}

function isMaskable(value: unknown): boolean {
  return (typeof value === 'string' && value !== '') || typeof value === 'number';
}

function maskNode(value: unknown, secretEntry: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => maskNode(item, secretEntry));
  if (value == null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const entry = secretEntry || isSecretConfigEntry(obj);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isMaskable(v) && (isCredentialName(k) || (entry && isConfigValueKey(k)))) {
      out[k] = REDACTED;
    } else {
      out[k] = maskNode(v, entry && isConfigAttributeList(k));
    }
  }
  return out;
}

/**
 * An OCPP payload with every station credential replaced by `[redacted]`:
 * a field named as a credential (SetNetworkProfile
 * `connectionData.basicAuthPassword`), and the value of a configuration entry
 * named as one (2.1 SetVariables, GetVariables and NotifyReport
 * `BasicAuthPassword`, 1.6 ChangeConfiguration and GetConfiguration
 * `AuthorizationKey`), in requests and responses of both versions. Keys stay,
 * so the log shows that a value was set. Never mutates `payload`.
 */
export function maskStationCredentials<T>(payload: T): T {
  return maskNode(payload, false) as T;
}

/** Whether a payload holds a station credential (`maskStationCredentials` would change it). */
export function holdsStationCredential(payload: unknown): boolean {
  return JSON.stringify(maskStationCredentials(payload)) !== JSON.stringify(payload);
}
