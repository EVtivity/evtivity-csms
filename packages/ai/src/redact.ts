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
 * 3. Configuration values: the `value` or `attributeValue` of an entry whose
 *    `key`, `name` or `variable.name` is secret-shaped (an OCPP 1.6
 *    `AuthorizationKey`, a 2.1 `SecurityCtrlr.BasicAuthPassword` in a logged
 *    SetVariables call, a `smtp.passwordEnc` setting row) is masked.
 * 4. Personal data: card numbers (Luhn-checked, grouped or contiguous) and
 *    IBANs are masked on every surface. On the support and driver surfaces,
 *    whose output can reach a driver, email addresses and phone numbers
 *    (phone fields, and `+` international numbers in text) are partly
 *    masked. `idToken` and OCPP 1.6 `idTag` values are replaced by a short
 *    hash on support and cut to their last 4 characters on driver, where the
 *    driver recognizes their own card.
 *
 * The second layer is the schema gate: the tool codegen and TC-AI-R-01 fail
 * when an exposed tool's response schema has a secret-shaped field.
 *
 * The third layer is the provider boundary: `redactProviderRequest` runs on
 * every model request (every `AI_USAGE_SURFACES` value maps to a redaction
 * surface) over the user text, the tool results, the text attachments and,
 * at the `chatbot` level, the system blocks.
 * TC-AI-AD-10 fails when a model call skips it. The verified result per
 * surface: `__contract__/data-handling.md`.
 */

import { createHash } from 'node:crypto';
import type { AiUsageSurface } from '@evtivity/lib/ai-usage';
import {
  REDACTED,
  SECRET_FLAG_PREFIX,
  isConfigAttributeList,
  isConfigValueKey,
  isSecretConfigEntry,
  normalizeSecretName,
} from '@evtivity/lib/secret-config';
import { TEXT_DOCUMENT_MIMES } from './core/types.js';
import type { AiAttachmentResolver, AiPart, AiRequest } from './core/types.js';

/**
 * Redaction profile: `support` for text that can reach a driver (support
 * drafts, insight evidence), `driver` for the driver AI evidence pack (the
 * driver's own data, read by an answer the driver sees), `chatbot` for
 * operator-only answers.
 */
export type RedactionSurface = 'chatbot' | 'support' | 'driver';

/** Surfaces whose output can reach a driver: emails, phones and token ids are masked. */
function masksPersonalData(surface: RedactionSurface): boolean {
  return surface === 'support' || surface === 'driver';
}

export interface RedactionCounts {
  /** Fields dropped because of a secret-shaped name. */
  keys: number;
  /** Secret values masked inside strings. */
  values: number;
  /** Personal data masked. */
  pii: number;
}

export { REDACTED };

/** Secret-shaped names, compared lowercased without `_`, `-` and `.`. */
const SECRET_KEY_SUFFIX =
  /(password|passwd|passphrase|secret|token|tokens|(?:api|private|client|secret|hmac|signing|encryption|access|auth|authorization|master|license)key|accesskeyid|clientcert|hmac|hash|enc|credential|credentials|signature|otp|totp|seed|salt|cookie|authorization)$/;

/** Names that look secret but are not, with the reason. */
const NOT_SECRET_KEYS: Readonly<Record<string, string>> = {
  tokentype: 'enum',
  maxtokens: 'a count',
};

/**
 * A driver token identifier (`idToken`, `tokenIdToken`, `groupIdToken`, the
 * OCPP 1.6 `idTag` and `parentIdTag`): an RFID uid or eMAID, personal data
 * rather than a secret. Hashed on the support surface, cut to the last 4
 * characters on the driver surface.
 */
function isIdTokenKey(normalized: string): boolean {
  return normalized.endsWith('idtoken') || normalized.endsWith('idtag');
}

const normalizeKey = normalizeSecretName;

/** Whether a field name marks a secret (`smtp.passwordEnc`, `api_key`, `webhookSecret`, `tokenHash`). */
export function isSecretShapedKey(key: string): boolean {
  if (SECRET_FLAG_PREFIX.test(key)) return false;
  const k = normalizeKey(key);
  if (Object.prototype.hasOwnProperty.call(NOT_SECRET_KEYS, k) || isIdTokenKey(k)) return false;
  return SECRET_KEY_SUFFIX.test(k);
}

/** Secret shapes inside strings, each masked whole. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
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

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';

/**
 * End of a PEM label (`[A-Z0-9 ]+` then `-----`) starting at `from`: the index
 * after the dashes, or -1. The label holds no `-`, so labels never overlap.
 */
function pemLabelEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    // A-Z, 0-9, space
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32) i++;
    else break;
  }
  if (i === from || !text.startsWith(PEM_DASHES, i)) return -1;
  return i + PEM_DASHES.length;
}

/**
 * Replaces each PEM block (`-----BEGIN <label>-----` up to the first
 * `-----END <label>-----`) with the redaction marker. A linear scan: the
 * regex form rescans to the end of the text for every BEGIN without an END,
 * quadratic on many repeated headers.
 */
function redactPemBlocks(text: string, onBlock: () => void): string {
  let out = '';
  let copied = 0;
  let search = 0;
  for (;;) {
    const begin = text.indexOf(PEM_BEGIN, search);
    if (begin === -1) break;
    const headerEnd = pemLabelEnd(text, begin + PEM_BEGIN.length);
    if (headerEnd === -1) {
      search = begin + 1;
      continue;
    }
    let blockEnd = -1;
    let endSearch = headerEnd;
    for (;;) {
      const end = text.indexOf(PEM_END, endSearch);
      if (end === -1) break;
      blockEnd = pemLabelEnd(text, end + PEM_END.length);
      if (blockEnd !== -1) break;
      endSearch = end + 1;
    }
    // No complete END after this header means none after a later one either.
    if (blockEnd === -1) break;
    out += text.slice(copied, begin) + REDACTED;
    onBlock();
    copied = blockEnd;
    search = blockEnd;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

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
/**
 * A card number written without separators: 13 to 19 digits starting with a
 * card network digit (2 to 6), Luhn-checked by `maskCard`. Millisecond
 * timestamps start with 1. Not applied to id fields (`transactionId`), whose
 * numeric values are not cards.
 */
const CONTIGUOUS_CARD_PATTERN = /(?<![\w.+-])[2-6]\d{12,18}(?![\w-]|[.,]\d)/g;
/**
 * An international phone number in text (`+49 30 1234567`, `+1 (555)
 * 123-4567`): 8 to 15 digits after `+`, separated by spaces, dashes or
 * brackets. National formats are not detected in free text; phone fields are
 * masked by name.
 */
const INTL_PHONE_PATTERN = /(?<![\w+])\+\d[\d ()-]{6,22}\d(?![\w.,]\d|\w)/g;
/** An ISO date after a `+` (`+2026-10-11`), which the phone pattern would match. */
const SIGNED_DATE = /^\+\d{4}-\d{2}-\d{2}$/;

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
/**
 * Id and device number fields (`transactionId`, `ids`, a modem `imsi` or
 * `iccid`, a serial number), whose numeric strings are never treated as
 * contiguous card numbers.
 */
const ID_KEYS = /(id|ids|imsi|iccid|serial|serialnumber)$/;

function maskTail(value: string, keep: number): string {
  const tail = value.replace(/[^A-Za-z0-9]/g, '').slice(-keep);
  return `****${tail}`;
}

interface Walk {
  surface: RedactionSurface;
  counts: RedactionCounts;
}

function maskCard(match: string, w: Walk): string {
  const digits = match.replace(/[ -]/g, '');
  if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return match;
  w.counts.pii++;
  return maskTail(digits, 4);
}

function redactString(input: string, w: Walk, options: { contiguousCards: boolean }): string {
  let out = redactPemBlocks(input, () => {
    w.counts.values++;
  });
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
  if (options.contiguousCards) {
    out = out.replace(CONTIGUOUS_CARD_PATTERN, (match) => maskCard(match, w));
  }
  out = out.replace(IBAN_PATTERN, (match) => {
    if (!ibanValid(match)) return match;
    w.counts.pii++;
    return maskTail(match, 4);
  });
  if (masksPersonalData(w.surface)) {
    out = out.replace(EMAIL_PATTERN, (_match, first: string, domain: string) => {
      w.counts.pii++;
      return `${first}***@${domain}`;
    });
    out = out.replace(INTL_PHONE_PATTERN, (match) => {
      const digits = match.replace(/\D/g, '').length;
      if (digits < 8 || digits > 15 || SIGNED_DATE.test(match)) return match;
      w.counts.pii++;
      return maskTail(match, 4);
    });
  }
  return out;
}

function hashIdToken(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/**
 * `secretConfig`: the value fields of this node belong to a configuration
 * entry named as a credential (`isSecretConfigEntry` of
 * `@evtivity/lib/secret-config`, the rule the OCPP message log shares): the
 * entry itself, or an item of its `variableAttribute` list. It never spreads
 * further down.
 */
function redactNode(value: unknown, key: string | null, w: Walk, secretConfig: boolean): unknown {
  if (
    secretConfig &&
    key != null &&
    isConfigValueKey(key) &&
    ((typeof value === 'string' && value !== '') || typeof value === 'number')
  ) {
    w.counts.values++;
    return REDACTED;
  }
  if (typeof value === 'string') {
    if (key != null && CARD_KEYS.test(normalizeKey(key)) && /^[\d -]+$/.test(value)) {
      return maskCard(value, w);
    }
    if (key != null && masksPersonalData(w.surface)) {
      const k = normalizeKey(key);
      if (isIdTokenKey(k) && value !== '') {
        w.counts.pii++;
        return w.surface === 'driver' ? maskTail(value, 4) : hashIdToken(value);
      }
      if (PHONE_KEYS.test(k) && value !== '') {
        w.counts.pii++;
        return maskTail(value, 4);
      }
    }
    return redactString(value, w, {
      contiguousCards: key == null || !ID_KEYS.test(normalizeKey(key)),
    });
  }
  // A Date serializes as its ISO string, as `JSON.stringify` would write it.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactNode(item, key, w, secretConfig));
  if (value != null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const secretEntry = secretConfig || isSecretConfigEntry(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // A secret is a scalar: an object under a secret-shaped name (a
      // session's `token` object) is walked, a boolean flag is kept.
      if (isSecretShapedKey(k) && (typeof v === 'string' || typeof v === 'number')) {
        w.counts.keys++;
        continue;
      }
      if (secretEntry && isConfigValueKey(k)) {
        out[k] = redactNode(v, k, w, true);
      } else {
        out[k] = redactNode(v, k, w, secretEntry && isConfigAttributeList(k));
      }
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
  surface: RedactionSurface,
): { value: unknown; counts: RedactionCounts } {
  const w: Walk = { surface, counts: emptyRedactionCounts() };
  return { value: redactNode(value, null, w, false), counts: w.counts };
}

/** Redacts free text (a non-JSON tool result, an error body). */
export function redactToolText(
  text: string,
  surface: RedactionSurface,
): { text: string; counts: RedactionCounts } {
  const w: Walk = { surface, counts: emptyRedactionCounts() };
  return { text: redactString(text, w, { contiguousCards: true }), counts: w.counts };
}

// ---------------------------------------------------------------------------
// Provider boundary
// ---------------------------------------------------------------------------

/**
 * The redaction level of every model-calling surface. Typed over
 * `AiUsageSurface`, so a new usage surface does not compile until it is
 * mapped (and TC-AI-AD-10 asks for its request-body test). Everything but the
 * operator's own chatbot uses `support` or stricter: system-run surfaces write
 * text that drivers and every operator can read.
 */
export const AI_USAGE_REDACTION_SURFACES: Readonly<Record<AiUsageSurface, RedactionSurface>> = {
  chatbot: 'chatbot',
  support: 'support',
  insight: 'support',
  insight_translation: 'support',
  worker: 'support',
  driver_support: 'driver',
};

function redactJsonText(text: string, surface: RedactionSurface): string | null {
  try {
    return JSON.stringify(redactToolValue(JSON.parse(text) as unknown, surface).value);
  } catch {
    // fail-open: not valid JSON, the caller redacts it as plain text.
    return null;
  }
}

/** A text attachment, redacted as data: JSON by field, everything else as text. */
function redactDocumentText(text: string, mime: string, surface: RedactionSurface): string {
  if (mime === 'application/json') {
    return redactJsonText(text, surface) ?? redactToolText(text, surface).text;
  }
  if (mime === 'application/x-ndjson') {
    return text
      .split('\n')
      .map((line) =>
        line.trim() === ''
          ? line
          : (redactJsonText(line, surface) ?? redactToolText(line, surface).text),
      )
      .join('\n');
  }
  return redactToolText(text, surface).text;
}

function redactingResolver(
  resolve: AiAttachmentResolver,
  surface: RedactionSurface,
): AiAttachmentResolver {
  return async (attachmentId) => {
    const content = await resolve(attachmentId);
    if (!(TEXT_DOCUMENT_MIMES as readonly string[]).includes(content.mime)) return content;
    const text = new TextDecoder().decode(content.data);
    return {
      ...content,
      data: new TextEncoder().encode(redactDocumentText(text, content.mime, surface)),
    };
  };
}

function redactPart(part: AiPart, surface: RedactionSurface): AiPart {
  if (part.type === 'text') return { ...part, text: redactToolText(part.text, surface).text };
  if (part.type === 'document' && part.name !== undefined) {
    return { ...part, name: redactToolText(part.name, surface).text };
  }
  if (part.type === 'tool_result') {
    // The field pass already checked contiguous card numbers outside id
    // fields; a text pass would treat a numeric `transactionId` as a card.
    const w: Walk = { surface, counts: emptyRedactionCounts() };
    const content = redactString(part.content, w, { contiguousCards: false });
    if (part.searchResults === undefined) return { ...part, content };
    // Documentation passages are public text, checked like any other text sent.
    return {
      ...part,
      content,
      searchResults: part.searchResults.map((r) => ({
        ...r,
        title: redactToolText(r.title, surface).text,
        text: redactToolText(r.text, surface).text,
      })),
    };
  }
  return part;
}

/**
 * The provider boundary: every model request passes through here right
 * before `adapter.stream` or `adapter.complete`. Redacts, at the usage
 * surface's level, every part that comes from outside the model: user and
 * tool message text, attachment names, tool results (already redacted by
 * field, so this is a second pass over the text) and text attachments
 * (`text/plain`, `text/csv`, JSON, NDJSON). Images and PDFs are sent as
 * uploaded. The system blocks (server text, the operator's surface prompt,
 * the Explain block already redacted where it is built) get the `chatbot`
 * level only: secrets, cards and IBANs, so a support email address in an
 * operator's prompt stays. Assistant messages (the model's own output and
 * its opaque provider state) are kept.
 */
export function redactProviderRequest(req: AiRequest, usageSurface: AiUsageSurface): AiRequest {
  const surface = AI_USAGE_REDACTION_SURFACES[usageSurface];
  return {
    ...req,
    system: req.system.map((block) => ({
      ...block,
      text: redactToolText(block.text, 'chatbot').text,
    })),
    messages: req.messages.map((message) =>
      message.role === 'assistant'
        ? message
        : { ...message, parts: message.parts.map((part) => redactPart(part, surface)) },
    ),
    ...(req.resolveAttachment !== undefined
      ? { resolveAttachment: redactingResolver(req.resolveAttachment, surface) }
      : {}),
  };
}
