// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The `pdf.logo` setting: validation of an uploaded PNG or SVG data URI, and
 * the SVG sanitizer. Server-side (the API on write, the PDF generators on
 * render).
 *
 * The sanitizer parses the SVG with an XML parser and copies only allowed SVG
 * elements and attributes into a new document, so scripts, event handlers,
 * foreign content, styles, embedded images, patterns and every reference
 * outside the document (href, url(), @import) are dropped, and so is a
 * `<use>` of an element that holds a `<use>` (no chained repeats). A DOCTYPE
 * or entity declaration rejects the file.
 */

import { DOMImplementation, DOMParser, XMLSerializer, onErrorStopParsing } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import { MAX_PDF_LOGO_BYTES } from './pdf-branding.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
]);

/** Elements whose text content is kept. */
const TEXT_ELEMENTS: ReadonlySet<string> = new Set(['text', 'tspan', 'title', 'desc']);

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'id',
  'style',
  'transform',
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'dx',
  'dy',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'points',
  'pathLength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'clip-path',
  'mask',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'display',
  'visibility',
  'overflow',
  'vector-effect',
  'paint-order',
  'shape-rendering',
  'text-rendering',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'maskUnits',
  'maskContentUnits',
  'clipPathUnits',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'word-spacing',
  'href',
]);

/** Every url(...) in the value points inside the document (url(#id)). */
function onlyLocalUrls(value: string): boolean {
  const refs = value.match(/url\s*\(([^)]*)\)/gi) ?? [];
  return refs.every((ref) => /^url\s*\(\s*['"]?#[^'")\s]+['"]?\s*\)$/i.test(ref));
}

function isSafeAttributeValue(name: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('data:')) return false;
  if (name === 'href') return /^#[A-Za-z_][\w.-]*$/.test(value);
  if (name === 'style') {
    // CSS escapes and at-rules can hide a reference from the url() check.
    if (value.includes('\\') || value.includes('@') || lower.includes('expression(')) return false;
  }
  return onlyLocalUrls(value);
}

/** Most elements an SVG may have, and how deep they may nest. */
const MAX_ELEMENTS = 10_000;
const MAX_DEPTH = 64;

class SvgTooComplexError extends Error {}

interface CopyState {
  elements: number;
}

function copyChildren(
  source: Element,
  target: Element,
  doc: Document,
  inText: boolean,
  depth: number,
  state: CopyState,
): void {
  if (depth > MAX_DEPTH) throw new SvgTooComplexError('SVG nesting too deep');
  for (let node = source.firstChild; node != null; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const child = copyElement(node as Element, doc, depth + 1, state);
      if (child != null) target.appendChild(child);
    } else if (inText && (node.nodeType === 3 || node.nodeType === 4)) {
      target.appendChild(doc.createTextNode(node.nodeValue ?? ''));
    }
  }
}

function copyElement(
  source: Element,
  doc: Document,
  depth: number,
  state: CopyState,
): Element | null {
  if (source.namespaceURI !== SVG_NS) return null;
  const name = source.localName;
  if (name == null || !ALLOWED_ELEMENTS.has(name)) return null;
  state.elements += 1;
  if (state.elements > MAX_ELEMENTS) throw new SvgTooComplexError('SVG has too many elements');
  const target = doc.createElementNS(SVG_NS, name);
  for (let i = 0; i < source.attributes.length; i++) {
    const attr = source.attributes.item(i);
    if (attr == null) continue;
    // xlink:href becomes href; every other namespaced attribute is dropped.
    const isXlinkHref = attr.namespaceURI === XLINK_NS && attr.localName === 'href';
    if (attr.namespaceURI != null && !isXlinkHref) continue;
    const attrName = isXlinkHref ? 'href' : attr.name;
    if (!ALLOWED_ATTRIBUTES.has(attrName)) continue;
    if (!isSafeAttributeValue(attrName, attr.value)) continue;
    target.setAttribute(attrName, attr.value);
  }
  copyChildren(source, target, doc, TEXT_ELEMENTS.has(name), depth, state);
  return target;
}

function descendants(root: Element): Element[] {
  const out: Element[] = [];
  const walk = (el: Element): void => {
    out.push(el);
    for (let node = el.firstChild; node != null; node = node.nextSibling) {
      if (node.nodeType === 1) walk(node as Element);
    }
  };
  walk(root);
  return out;
}

/**
 * Removes every `<use>` that points at a missing element or at one that is
 * or holds a `<use>` itself. Chained uses multiply the drawing work with
 * each level (the "billion laughs" of SVG), so a use may only repeat plain
 * shapes.
 */
function dropChainedUses(root: Element): void {
  const all = descendants(root);
  const byId = new Map<string, Element>();
  for (const el of all) {
    const id = el.getAttribute('id');
    if (id != null && id !== '' && !byId.has(id)) byId.set(id, el);
  }
  for (const use of all.filter((el) => el.localName === 'use')) {
    const target = byId.get((use.getAttribute('href') ?? '').slice(1));
    const chained = target == null || descendants(target).some((el) => el.localName === 'use');
    if (chained) use.parentNode?.removeChild(use);
  }
}

/**
 * The SVG with only allowed elements and attributes, or null when it is not
 * a well-formed SVG document, declares a DOCTYPE or entities, is larger than
 * MAX_PDF_LOGO_BYTES, or has more than 10000 elements or 64 levels.
 */
export function sanitizeSvg(svg: string): string | null {
  if (Buffer.byteLength(svg, 'utf8') > MAX_PDF_LOGO_BYTES) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return null;
  let parsed: Document;
  try {
    const parser = new DOMParser({ onError: onErrorStopParsing });
    parsed = parser.parseFromString(svg, 'image/svg+xml');
  } catch {
    // fail-open: an unparsable upload is rejected (null), not an error.
    return null;
  }
  const root = parsed.documentElement;
  if (root == null || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
  const doc = new DOMImplementation().createDocument(SVG_NS, 'svg', null);
  const out = doc.documentElement;
  if (out == null) return null;
  let copied: Element | null;
  try {
    copied = copyElement(root, doc, 0, { elements: 0 });
  } catch (err) {
    if (err instanceof SvgTooComplexError) return null;
    throw err;
  }
  if (copied == null) return null;
  for (let i = 0; i < copied.attributes.length; i++) {
    const attr = copied.attributes.item(i);
    if (attr != null) out.setAttribute(attr.name, attr.value);
  }
  while (copied.firstChild != null) out.appendChild(copied.firstChild);
  dropChainedUses(out);
  return new XMLSerializer().serializeToString(doc);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** A decoded logo: sanitized SVG markup, or PNG or JPEG bytes. */
export type DecodedPdfLogo =
  | { kind: 'svg'; svg: string }
  | { kind: 'png'; data: Buffer }
  | { kind: 'jpeg'; data: Buffer };

function decodeDataUri(value: string): { mime: string; data: Buffer } | null {
  const match = /^data:([a-z0-9.+/-]+)(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(value.trim());
  if (match == null) return null;
  const mime = (match[1] ?? '').toLowerCase();
  const payload = match[4] ?? '';
  try {
    const data =
      match[3] != null
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8');
    return { mime, data };
  } catch {
    // fail-open: a malformed percent-encoding is an invalid logo (null).
    return null;
  }
}

/**
 * Decodes a stored or uploaded logo data URI. SVG comes back sanitized; PNG
 * and JPEG must carry their file signature. `allowJpeg` is for rendering
 * only: an upload accepts PNG and SVG, while a JPEG `company.logo` copied by
 * migration 0395 still renders. Returns null for anything else, an empty
 * file, or one larger than MAX_PDF_LOGO_BYTES.
 */
export function decodePdfLogo(
  value: unknown,
  options: { allowJpeg?: boolean } = {},
): DecodedPdfLogo | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const decoded = decodeDataUri(value);
  if (decoded == null) return null;
  const { mime, data } = decoded;
  if (data.length === 0 || data.length > MAX_PDF_LOGO_BYTES) return null;
  if (mime === 'image/svg+xml') {
    const svg = sanitizeSvg(data.toString('utf8'));
    return svg != null ? { kind: 'svg', svg } : null;
  }
  if (mime === 'image/png') {
    return data.subarray(0, 8).equals(PNG_SIGNATURE) ? { kind: 'png', data } : null;
  }
  if (options.allowJpeg === true && (mime === 'image/jpeg' || mime === 'image/jpg')) {
    return data.subarray(0, 3).equals(JPEG_SIGNATURE) ? { kind: 'jpeg', data } : null;
  }
  return null;
}

/**
 * The value to store for an uploaded `pdf.logo`: '' (use the default) for an
 * empty string, a base64 data URI of the sanitized SVG or of the PNG, or null
 * when the value is not a valid PNG or SVG data URI.
 */
export function normalizePdfLogo(value: unknown): string | null {
  if (value === '') return '';
  const logo = decodePdfLogo(value);
  if (logo == null) return null;
  if (logo.kind === 'svg') {
    const data = Buffer.from(logo.svg, 'utf8');
    if (data.length > MAX_PDF_LOGO_BYTES) return null;
    return `data:image/svg+xml;base64,${data.toString('base64')}`;
  }
  if (logo.kind === 'png') return `data:image/png;base64,${logo.data.toString('base64')}`;
  return null;
}
