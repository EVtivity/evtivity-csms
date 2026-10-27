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
 *
 * URL passwords (`maskUrlPassword`): an OCPP file transfer URL may carry its
 * credentials in the userinfo (`ftp://user:password@host:port/path`, OCPP 2.1
 * GetLog and UpdateFirmware). Every stored or logged copy masks the password.
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

/**
 * Nesting deeper than this is replaced whole by `[redacted]`. No OCPP payload
 * nests this deep, and the cap keeps a hostile payload from overflowing the
 * stack (the OCPP server refuses frames past 32 levels before they get here).
 */
export const MAX_MASK_DEPTH = 64;

/**
 * Strings longer than this are never scanned for URL passwords: one that
 * holds a `:` is replaced whole (`maskUrlPassword`) and refused on write
 * (`urlPasswordUnmaskable`), so the cost of a scan stays bounded. The SQL
 * twins of migration 0479 use the same bound (in code points).
 */
export const MAX_URL_SCAN_LENGTH = 65_536;

/** An ASCII control or space: it ends a URL in free text. */
function isUrlBreak(code: number): boolean {
  return code <= 0x20;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** `[A-Za-z0-9+.-]`, the characters after the first one of a URL scheme. */
function isSchemeChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x2e
  );
}

/** `/`, `?` or `#`. */
function isPathDelimiter(code: number): boolean {
  return code === 0x2f || code === 0x3f || code === 0x23;
}

/**
 * Whether a `scheme` ends right before the `://` at `k`: a letter, then
 * scheme characters, starting at or after `floor`. The walk back stops at
 * the first character that is no scheme character (the `/` of an earlier
 * `://` at the latest), so the walks of all `://` cover the text once.
 */
function hasSchemeBefore(text: string, k: number, floor: number): boolean {
  let j = k;
  while (j > floor && isSchemeChar(text.charCodeAt(j - 1))) j--;
  while (j < k && !isAsciiLetter(text.charCodeAt(j))) j++;
  return j < k;
}

/**
 * The index of the `:` that ends the user of `scheme://user:`, scanning from
 * `from` (right after `://`): the user holds no `:`, `/`, `?`, `#` or break.
 * -1 when the user does not end in a `:`.
 */
function userColonAfter(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x3a) return i;
    if (isUrlBreak(code) || isPathDelimiter(code)) return -1;
  }
  return -1;
}

/**
 * The password of a URL's userinfo (`ftp://user:password@host/path`, the OCPP
 * file transfer form of GetLog, GetDiagnostics, UpdateFirmware and
 * PublishFirmware locations), anywhere in a decoded string value (never JSON
 * text: a quote or a backslash is a password character). It masks at least
 * what any URL parser reads as the password: from `scheme://user:` (the user
 * may hold an `@`, never a `:`, `/`, `?` or `#`) to the last `@` before the
 * next ASCII control or space. The WHATWG parser ends the authority at the
 * first `/`, `?` or `#` (and at `\` for special schemes), other parsers do not,
 * so the run goes through them: a path `@` after a password, or after a port
 * (`ftp://host:21/a@b`), is over-masked, never a password under-masked.
 *
 * An ASCII control or space ends the URL, since free text (an error
 * description) holds URLs between words. WHATWG drops tabs and newlines and
 * encodes a space inside a userinfo instead, so such a URL is refused where
 * it is written (`urlPasswordUnmaskable`), as is a userinfo holding a raw
 * `/`, `?` or `#`, which parsers read differently.
 * Text that is no `scheme://` URL (`user:pass@host`, free text) never matches.
 *
 * A linear scan, no regular expression (a backtracking pattern let a crafted
 * string stall the process): each `://` is looked at once, the scheme walk,
 * the user walk and the password run of each break-free run cover disjoint
 * text, and the last `@` of a run is found once. Matches never overlap: after
 * one, the scan resumes after its `@`, as a global replace would. The SQL
 * functions of migration 0479 (`evtivity_mask_url_passwords`, and
 * `evtivity_mask_url_passwords_jsonb` over JSON string values) run the same
 * scan.
 */
function maskUrlPasswordScan(text: string): string {
  let out = '';
  let copied = 0;
  let floor = 0;
  let searchFrom = 0;
  let runEnd = -1;
  let lastAt = -1;
  for (;;) {
    const k = text.indexOf('://', searchFrom);
    if (k < 0) break;
    searchFrom = k + 1;
    if (!hasSchemeBefore(text, k, floor)) continue;
    const colon = userColonAfter(text, k + 3);
    if (colon < 0) continue;
    if (colon + 1 >= runEnd) {
      // The break-free run holding the password, and its last @ (once per run).
      runEnd = colon + 1;
      while (runEnd < text.length && !isUrlBreak(text.charCodeAt(runEnd))) runEnd++;
      lastAt = -1;
      for (let i = runEnd - 1; i >= colon + 2; i--) {
        if (text.charCodeAt(i) === 0x40) {
          lastAt = i;
          break;
        }
      }
    }
    if (lastAt < colon + 2) {
      // No @ after a password in this run: no later start in it matches.
      searchFrom = Math.max(searchFrom, runEnd);
      continue;
    }
    out += `${text.slice(copied, colon + 1)}${REDACTED}`;
    copied = lastAt;
    floor = lastAt + 1;
    searchFrom = lastAt + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/**
 * A string with the password of every URL userinfo in it replaced by
 * `[redacted]`: `sftp://logs:secret@host:22/up` becomes
 * `sftp://logs:[redacted]@host:22/up`. The scheme, user, host, port and path
 * stay, so the operator still sees where a file went. A userinfo without a
 * password (`ftp://user@host`) and text that is no URL stay as they are. A
 * string longer than `MAX_URL_SCAN_LENGTH` that holds a `:` is replaced whole.
 * Idempotent.
 */
export function maskUrlPassword(text: string): string {
  if (!text.includes(':')) return text;
  // Past the bound any colon counts: breaks inside the separator (`ftp:/ /`)
  // hide `://` from a literal check, and parsers drop them.
  if (text.length > MAX_URL_SCAN_LENGTH) return REDACTED;
  if (!text.includes('://')) return text;
  return maskUrlPasswordScan(text);
}

/** Whether a string holds a URL with a password in its userinfo. */
export function holdsUrlPassword(text: string): boolean {
  return maskUrlPassword(text) !== text;
}

/**
 * Whether a `scheme://user:` is followed, before the first `@` of its
 * break-free run, by a raw `/`, `?` or `#` (`ftp://user:pa/ss@host`, and a
 * port followed by a path `@`): parsers disagree on whether that `@` ends a
 * userinfo. Linear: a candidate without such a delimiter has no `://` before
 * its first `@`, and one whose run has no `@` ends the run.
 */
function holdsAmbiguousUserinfo(text: string): boolean {
  let searchFrom = 0;
  for (;;) {
    const k = text.indexOf('://', searchFrom);
    if (k < 0) return false;
    searchFrom = k + 1;
    if (!hasSchemeBefore(text, k, 0)) continue;
    const colon = userColonAfter(text, k + 3);
    if (colon < 0) continue;
    let delimiter = false;
    let i = colon + 1;
    for (; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x40 || isUrlBreak(code)) break;
      if (isPathDelimiter(code)) delimiter = true;
    }
    if (delimiter && i < text.length && text.charCodeAt(i) === 0x40) return true;
    // Either no @ is left in this run, so no later start in it has one, or
    // the run up to the @ holds no `/`, so no later `://` starts before it.
    searchFrom = Math.max(searchFrom, i);
  }
}

/**
 * Whether a value holds a URL password that `maskUrlPassword` cannot show
 * masked: an ASCII control or space inside the value (after trimming its
 * ends, as the WHATWG parser does) while the value read without them holds a
 * URL password. A station parser drops the tab or newline, or encodes the
 * space, and uses the whole password, while the masker ends the URL there
 * and would leave the password in plain text. Also a userinfo holding a raw
 * `/`, `?` or `#` before an `@` (`ftp://user:pa/ss@host`, and a port followed
 * by a path `@`): parsers read where it ends differently, so it must be
 * percent-encoded. And a string longer than `MAX_URL_SCAN_LENGTH` that holds
 * a `:`. Writes refuse such a value (firmware campaigns, the OCPP command
 * routes) with 400 `VALIDATION_ERROR`, and the access log and the AI redactor
 * store it as `[redacted]` whole.
 */
export function urlPasswordUnmaskable(value: string): boolean {
  if (!value.includes(':')) return false;
  // Past the bound any colon counts, as in `maskUrlPassword`.
  if (value.length > MAX_URL_SCAN_LENGTH) return true;
  let start = 0;
  let end = value.length;
  while (start < end && isUrlBreak(value.charCodeAt(start))) start++;
  while (end > start && isUrlBreak(value.charCodeAt(end - 1))) end--;
  let joined = '';
  let inner = false;
  let from = start;
  for (let i = start; i < end; i++) {
    if (isUrlBreak(value.charCodeAt(i))) {
      joined += value.slice(from, i);
      from = i + 1;
      inner = true;
    }
  }
  joined += value.slice(from, end);
  return (inner && holdsUrlPassword(joined)) || holdsAmbiguousUserinfo(joined);
}

/** Whether any string of a payload, at any depth, is `urlPasswordUnmaskable`. */
export function holdsUnmaskableUrlPassword(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return urlPasswordUnmaskable(value);
  if (value == null || typeof value !== 'object' || depth >= MAX_MASK_DEPTH) return false;
  const items = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return items.some((item) => holdsUnmaskableUrlPassword(item, depth + 1));
}

function maskNode(value: unknown, secretEntry: boolean, depth: number, urls: boolean): unknown {
  if (typeof value === 'string') return urls ? maskUrlPassword(value) : value;
  if (value == null || typeof value !== 'object') return value;
  if (depth >= MAX_MASK_DEPTH) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => maskNode(item, secretEntry, depth + 1, urls));
  }
  const obj = value as Record<string, unknown>;
  const entry = secretEntry || isSecretConfigEntry(obj);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isMaskable(v) && (isCredentialName(k) || (entry && isConfigValueKey(k)))) {
      out[k] = REDACTED;
    } else {
      out[k] = maskNode(v, entry && isConfigAttributeList(k), depth + 1, urls);
    }
  }
  return out;
}

function maskUrlsOnly(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return maskUrlPassword(value);
  if (value == null || typeof value !== 'object' || value instanceof Date) return value;
  if (depth >= MAX_MASK_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => maskUrlsOnly(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = maskUrlsOnly(v, depth + 1);
  }
  return out;
}

/**
 * A value with the password of every URL userinfo in its strings replaced by
 * `[redacted]` (`maskUrlPassword`), at any depth; nothing else changes. For
 * stored copies of payloads that hold no station credential rule but can
 * hold a file transfer URL (persisted domain events, firmware and log upload
 * history, audit rows). A subtree nested deeper than `MAX_MASK_DEPTH` is
 * replaced whole. Never mutates `value`.
 */
export function maskUrlPasswords<T>(value: T): T {
  return maskUrlsOnly(value, 0) as T;
}

/**
 * An OCPP payload with every station credential replaced by `[redacted]`:
 * a field named as a credential (SetNetworkProfile
 * `connectionData.basicAuthPassword`), the value of a configuration entry
 * named as one (2.1 SetVariables, GetVariables and NotifyReport
 * `BasicAuthPassword`, 1.6 ChangeConfiguration and GetConfiguration
 * `AuthorizationKey`), in requests and responses of both versions, and the
 * password of a URL userinfo in any string (`maskUrlPassword`: GetLog
 * `log.remoteLocation`, 1.6 GetDiagnostics `location`, UpdateFirmware
 * `firmware.location` or 1.6 `location`, PublishFirmware `location`). Keys
 * stay, so the log shows that a value was set. A subtree nested deeper than
 * `MAX_MASK_DEPTH` is replaced whole. Never mutates `payload`.
 */
export function maskStationCredentials<T>(payload: T): T {
  return maskNode(payload, false, 0, true) as T;
}

/**
 * Whether a payload holds a station credential by the name rule (a credential
 * field or configuration entry; not a URL password): the commands that are
 * never queued for an offline station and never sent through the generic
 * configuration routes. A file transfer URL with a password is masked in
 * every stored copy but still queued, since the station needs it.
 */
export function holdsStationCredential(payload: unknown): boolean {
  return JSON.stringify(maskNode(payload, false, 0, false)) !== JSON.stringify(payload);
}
