// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Rules of the security templates (password reset, invitations, verification,
// sign-in codes, payout onboarding and the security notices):
// a template can neither send an account link or code anywhere else nor link
// to a host other than the CSMS or the portal. The API refuses a save that
// breaks them; dispatch ignores a stored template that does and sends the
// shipped file. Server-only (htmlparser2).

import { Parser } from 'htmlparser2';
import { SECURITY_TEMPLATE_EVENTS } from './notification-events.js';
import { flattenTemplate } from './template-safety.js';

/** A secret value and how it may appear: a link only as a whole link address. */
interface SecretToken {
  name: string;
  value: string;
  link: boolean;
}

/** Elements whose text a mail client never shows as text (and may fetch from). */
const RAW_TEXT_ELEMENTS = new Set(['style', 'script', 'title', 'textarea', 'xmp']);

/** Elements that end a run of text, so text before and after never joins into one link. */
const BLOCK_ELEMENTS = new Set([
  'p',
  'div',
  'br',
  'td',
  'th',
  'tr',
  'table',
  'tbody',
  'thead',
  'li',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'center',
  'blockquote',
  'pre',
  'section',
]);

/** Attributes a mail client reads as one URL (a link, an image, a form target). */
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'background',
  'poster',
  'cite',
  'longdesc',
  'lowsrc',
  'dynsrc',
  'data',
  'codebase',
  'manifest',
  'icon',
  'ping',
  'xlink:href',
]);

/** Link schemes that fetch nothing and point at no host. */
const NO_HOST_SCHEMES = new Set(['mailto:', 'tel:']);

// Placeholders of the save check. A link placeholder lives on a reserved host
// (RFC 2606 `.invalid`), so the host check accepts it; a plain variable renders
// as letters, so a host or link built from one never looks trusted.
const LINK_PLACEHOLDER_ORIGIN = 'https://evtivity-link.invalid';
const VARIABLE_PLACEHOLDER = 'evtivityvar';

// `//host` or `scheme://host` (a backslash counts as a slash, as browsers parse it).
const HOST_REFERENCE_RE = /([a-z][a-z0-9+.-]*:)?[/\\]{2,}([^\s"'<>()\\/?#]*)/gi;
// `https:host` without slashes, which browsers also read as an absolute URL.
const SLASHLESS_URL_RE = /\b(?:https?|wss?|ftp):(?![/\\])/i;

function hostAllowed(
  scheme: string | undefined,
  hostPart: string,
  trusted: readonly URL[],
): boolean {
  const host = hostPart.slice(hostPart.lastIndexOf('@') + 1);
  if (host === '') return true;
  const parsed = URL.parse(`${scheme ?? 'https:'}//${host}`);
  if (parsed == null) return false;
  if (scheme == null) return trusted.some((t) => t.host === parsed.host);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return trusted.some((t) => t.origin === parsed.origin);
}

/** Problems with the URLs in a piece of text (an attribute value, text, a comment). */
function urlProblem(text: string, trusted: readonly URL[]): string | null {
  if (SLASHLESS_URL_RE.test(text)) return 'Write links in full (https://...)';
  for (const match of text.matchAll(HOST_REFERENCE_RE)) {
    if (!hostAllowed(match[1]?.toLowerCase(), match[2] ?? '', trusted)) {
      return 'A security template may link only to the CSMS or the driver portal';
    }
  }
  return null;
}

/** Problems with an attribute value as a browser reads it: an absolute URL on another host. */
function attributeUrlProblem(value: string, trusted: readonly URL[]): string | null {
  // URL parsing drops tabs and newlines anywhere and spaces at the ends.
  const stripped = value.replace(/[\t\n\r]/g, '').trim();
  const absolute = URL.parse(stripped);
  if (absolute != null) {
    if (NO_HOST_SCHEMES.has(absolute.protocol)) return null;
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
      return `"${absolute.protocol}" links are not allowed in a security template`;
    }
    if (!trusted.some((t) => t.origin === absolute.origin)) {
      return 'A security template may link only to the CSMS or the driver portal';
    }
    return null;
  }
  const relative = URL.parse(stripped, 'https://relative.invalid/');
  if (relative != null && relative.host !== 'relative.invalid') {
    if (!trusted.some((t) => t.host === relative.host)) {
      return 'A security template may link only to the CSMS or the driver portal';
    }
  }
  return urlProblem(stripped, trusted);
}

function tokenNotice(token: SecretToken): string {
  return token.link
    ? `{{${token.name}}} may appear only as a whole link address (<a href="{{${token.name}}}">) or as text`
    : `{{${token.name}}} may appear only as text`;
}

// A secret in text must follow whitespace or CJK or fullwidth punctuation (`：`), so
// it never extends a link written before it.
const TEXT_BOUNDARY_RE = /[\s\u3000-\u303f\uff00-\uffef]/u;

/** Each place a secret appears in text must start a word, so it cannot extend a link. */
function textPlacementProblem(text: string, tokens: readonly SecretToken[]): string | null {
  for (const token of tokens) {
    let at = text.indexOf(token.value);
    while (at !== -1) {
      if (at > 0 && !TEXT_BOUNDARY_RE.test(text.charAt(at - 1))) return tokenNotice(token);
      at = text.indexOf(token.value, at + token.value.length);
    }
  }
  return null;
}

interface CheckOptions {
  html: boolean;
  tokens: readonly SecretToken[];
  /** Null: placement only (the render check); else the hosts links may name. */
  trusted: readonly URL[] | null;
}

function contentProblem(content: string, options: CheckOptions): string | null {
  const { tokens, trusted } = options;
  if (trusted != null && content.includes('\\')) {
    return 'A backslash is not allowed in a security template';
  }
  if (!options.html) {
    return (
      textPlacementProblem(content, tokens) ??
      (trusted != null ? urlProblem(content, trusted) : null)
    );
  }

  let problem: string | null = null;
  let text = '';
  let rawDepth = 0;
  const fail = (message: string | null): void => {
    if (problem == null && message != null) problem = message;
  };
  const hasToken = (value: string): SecretToken | undefined =>
    tokens.find((token) => value.includes(token.value));

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (BLOCK_ELEMENTS.has(name)) text += '\n';
        if (RAW_TEXT_ELEMENTS.has(name)) rawDepth += 1;
        for (const [attribute, value] of Object.entries(attributes)) {
          const token = hasToken(value);
          if (token != null) {
            const wholeLink =
              token.link && name === 'a' && attribute === 'href' && value.trim() === token.value;
            if (!wholeLink) fail(tokenNotice(token));
          }
          if (trusted != null) {
            fail(
              URL_ATTRIBUTES.has(attribute)
                ? attributeUrlProblem(value, trusted)
                : urlProblem(value, trusted),
            );
          }
        }
      },
      onclosetag(name) {
        if (BLOCK_ELEMENTS.has(name)) text += '\n';
        if (RAW_TEXT_ELEMENTS.has(name) && rawDepth > 0) rawDepth -= 1;
      },
      ontext(chunk) {
        if (rawDepth > 0) {
          const token = hasToken(chunk);
          if (token != null) fail(tokenNotice(token));
          if (trusted != null) fail(urlProblem(chunk, trusted));
          return;
        }
        text += chunk;
      },
      oncomment(comment) {
        // Outlook renders conditional comments, so they count as content.
        const token = hasToken(comment);
        if (token != null) fail(tokenNotice(token));
        if (trusted != null) fail(urlProblem(comment, trusted));
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(content);
  parser.end();
  fail(textPlacementProblem(text, tokens));
  if (trusted != null) fail(urlProblem(text, trusted));
  return problem;
}

/** The secret variables a template must keep: those its shipped file uses. */
function requiredSecrets(eventType: string, shippedBody: string | null): string[] {
  const secrets = SECURITY_TEMPLATE_EVENTS[eventType];
  if (secrets == null || shippedBody == null) return [];
  let used: ReadonlySet<string>;
  try {
    used = flattenTemplate(shippedBody, () => '').variables;
  } catch {
    // fail-open: a shipped file the allowlist refuses requires nothing; its own
    // render reports the error.
    return [];
  }
  return [...secrets.links, ...secrets.codes].filter((name) => used.has(name));
}

export interface SecurityTemplateDraft {
  eventType: string;
  channel: string;
  subject: string | null | undefined;
  bodyHtml: string | null | undefined;
  /** The shipped file of the same event, channel and language (English when none), or null. */
  shippedBody: string | null;
  /** The CSMS and portal URLs links may point to. */
  trustedUrls: readonly string[];
}

/**
 * Save check of a security template. Null when `eventType` is not a security
 * event or the draft passes; else the problem per field (`subject`, `bodyHtml`).
 * Every `{{#if}}` branch is checked. The template must already pass the
 * Handlebars allowlist (`assertTemplateAllowed`).
 */
export function securityTemplateSaveProblems(
  draft: SecurityTemplateDraft,
): Record<string, string> | null {
  const secrets = SECURITY_TEMPLATE_EVENTS[draft.eventType];
  if (secrets == null) return null;
  const trusted = [
    ...draft.trustedUrls.map((url) => URL.parse(url)).filter((url): url is URL => url != null),
    new URL(LINK_PLACEHOLDER_ORIGIN),
  ];
  const tokens: SecretToken[] = [
    ...secrets.links.map((name) => ({
      name,
      value: `${LINK_PLACEHOLDER_ORIGIN}/${name}`,
      link: true,
    })),
    ...secrets.codes.map((name) => ({ name, value: `EVTIVITYCODE${name}`, link: false })),
  ];
  const placeholder = (name: string): string =>
    tokens.find((token) => token.name === name)?.value ?? VARIABLE_PLACEHOLDER;

  const problems: Record<string, string> = {};
  const body = draft.bodyHtml ?? '';
  if (body.trim() === '') {
    problems['bodyHtml'] = 'A security template cannot be empty';
  } else {
    const flat = flattenTemplate(body, placeholder);
    const missing = requiredSecrets(draft.eventType, draft.shippedBody).filter(
      (name) => !flat.variables.has(name),
    );
    const bodyProblem =
      missing.length > 0
        ? `A security template must keep ${missing.map((name) => `{{${name}}}`).join(', ')}`
        : contentProblem(flat.text, { html: draft.channel === 'email', tokens, trusted });
    if (bodyProblem != null) problems['bodyHtml'] = bodyProblem;
  }
  if (draft.subject != null && draft.subject !== '') {
    const subjectProblem = contentProblem(flattenTemplate(draft.subject, placeholder).text, {
      html: false,
      tokens,
      trusted,
    });
    if (subjectProblem != null) problems['subject'] = subjectProblem;
  }
  return Object.keys(problems).length > 0 ? problems : null;
}

export interface SecurityTemplateRendered {
  eventType: string;
  channel: string;
  /** The rendered stored template. */
  subject: string | null;
  body: string;
  /** The shipped file the stored template replaces, or null. */
  shippedBody: string | null;
  /** The variables it was rendered with (the server-built links and codes among them). */
  variables: Record<string, unknown>;
}

/**
 * Render check of a stored security template: null when it may be sent, else
 * why dispatch sends the shipped file instead. The links and codes this render
 * carries must appear only as a whole link address or as text, and each one the
 * shipped file uses must appear. Null for any other event type.
 */
export function securityTemplateRenderProblem(rendered: SecurityTemplateRendered): string | null {
  const secrets = SECURITY_TEMPLATE_EVENTS[rendered.eventType];
  if (secrets == null) return null;
  if (rendered.body.trim() === '') return 'empty';
  const tokens: SecretToken[] = [];
  for (const [names, link] of [
    [secrets.links, true],
    [secrets.codes, false],
  ] as const) {
    for (const name of names) {
      const value = rendered.variables[name];
      if (typeof value === 'string' && value !== '') tokens.push({ name, value, link });
      else if (typeof value === 'number') tokens.push({ name, value: String(value), link });
    }
  }
  // An HTML body holds `=` and `&` in links as entities; the parser decodes them.
  const missing = requiredSecrets(rendered.eventType, rendered.shippedBody).filter((name) => {
    const token = tokens.find((t) => t.name === name);
    return token != null && !decodedText(rendered.body, rendered.channel).includes(token.value);
  });
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  return (
    contentProblem(rendered.body, { html: rendered.channel === 'email', tokens, trusted: null }) ??
    (rendered.subject != null
      ? contentProblem(rendered.subject, { html: false, tokens, trusted: null })
      : null)
  );
}

/** The body with HTML entities decoded (attribute values and text), for a presence check. */
function decodedText(body: string, channel: string): string {
  if (channel !== 'email') return body;
  let out = '';
  const parser = new Parser(
    {
      onopentag(_name, attributes) {
        out += ` ${Object.values(attributes).join(' ')} `;
      },
      ontext(chunk) {
        out += chunk;
      },
    },
    { decodeEntities: true },
  );
  parser.write(body);
  parser.end();
  return out;
}
