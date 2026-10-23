// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Policy of every email preview iframe. The `sandbox=""` attribute already
 * blocks scripts, forms and navigation; this also blocks every remote load
 * (images, fonts, styles), so a template or a logged email cannot make the
 * viewing operator's browser call a URL. Inline styles and data
 * images still render.
 */
export const EMAIL_PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`;

/**
 * The `srcDoc` of an email preview: the policy is the first element, right
 * after a leading doctype (kept). The HTML parser puts a meta that comes
 * before `<html>` into the head and ignores the later `<head>` tag, so no
 * earlier comment or element can carry the policy into a comment or the body,
 * where a CSP meta does nothing.
 */
export function emailPreviewDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype == null) return `${POLICY_META}${html}`;
  const end = doctype[0].length;
  return `${html.slice(0, end)}${POLICY_META}${html.slice(end)}`;
}
