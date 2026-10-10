// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { decodePdfLogo, normalizePdfLogo, sanitizeSvg } from '../pdf-logo.js';
import {
  DEFAULT_PDF_LOGO_SVG,
  MAX_PDF_FOOTER_LENGTH,
  MAX_PDF_LOGO_BYTES,
  defaultPdfLogoDataUri,
  normalizePdfFooter,
} from '../pdf-branding.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('sanitizeSvg', () => {
  it('keeps shapes, gradients, masks and local references', () => {
    const svg = `<svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient><mask id="m"><rect width="10" height="10" fill="white"/></mask></defs><circle cx="5" cy="5" r="4" fill="url(#g)" mask="url(#m)"/><use href="#m"/></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('mask="url(#m)"');
    expect(out).toContain('<use href="#m"/>');
    expect(out).toContain('viewBox="0 0 10 10"');
  });

  it('drops scripts, event handlers, foreign content, styles and images', () => {
    const svg = `<svg ${NS} onload="alert(1)"><script>alert(1)</script><style>@import url(https://x.test/a.css);</style><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject><image href="https://x.test/a.png"/><a href="javascript:alert(1)"><rect width="1" height="1"/></a><rect width="2" height="2" onclick="alert(1)"/></svg>`;
    const out = sanitizeSvg(svg) ?? '';
    expect(out).not.toMatch(
      /script|onload|onclick|style|foreignObject|image|javascript|x\.test|<a/i,
    );
    expect(out).toContain('<rect width="2" height="2"/>');
  });

  it('drops external references in href, url() and style', () => {
    const svg = `<svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://x.test/s.svg#a"/><use xlink:href="#local"/><rect id="local" width="1" height="1"/><rect fill="url(https://x.test/p)" width="1" height="1"/><rect style="fill:url('https://x.test/p')" width="1" height="1"/><rect style="fill:red" width="1" height="1"/><rect style="fill:\\75rl(x)" width="1" height="1"/></svg>`;
    const out = sanitizeSvg(svg) ?? '';
    expect(out).not.toContain('x.test');
    expect(out).toContain('<use href="#local"/>');
    expect(out).toContain('style="fill:red"');
    expect(out).not.toContain('\\75');
  });

  it('rejects DOCTYPE and entity declarations', () => {
    expect(
      sanitizeSvg(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg ${NS}>&x;</svg>`),
    ).toBeNull();
  });

  it('rejects malformed XML, non-SVG roots and oversized files', () => {
    expect(sanitizeSvg(`<svg ${NS}><rect></svg>`)).toBeNull();
    expect(sanitizeSvg('<html><body/></html>')).toBeNull();
    expect(sanitizeSvg(`<svg ${NS}>${' '.repeat(MAX_PDF_LOGO_BYTES)}</svg>`)).toBeNull();
  });

  it('gives an SVG without a namespace declaration the SVG namespace', () => {
    expect(sanitizeSvg('<svg><rect width="1" height="1"/></svg>')).toBe(
      `<svg ${NS}><rect width="1" height="1"/></svg>`,
    );
  });

  it('drops a use of an element that holds a use, and a use of a missing element', () => {
    const svg = `<svg ${NS}><defs><g id="a"><rect width="1" height="1"/></g><g id="b"><use href="#a"/><use href="#a"/></g></defs><use href="#b"/><use href="#a"/><use href="#nope"/></svg>`;
    const out = sanitizeSvg(svg) ?? '';
    expect(out.match(/<use /g)).toHaveLength(3);
    expect(out).not.toContain('href="#b"');
    expect(out).not.toContain('#nope');
  });

  it('drops patterns and rejects deep or huge documents', () => {
    expect(sanitizeSvg(`<svg ${NS}><pattern id="p"><rect/></pattern></svg>`)).toBe(`<svg ${NS}/>`);
    const deep = `<svg ${NS}>${'<g>'.repeat(70)}${'</g>'.repeat(70)}</svg>`;
    expect(sanitizeSvg(deep)).toBeNull();
    const many = `<svg ${NS}>${'<rect/>'.repeat(10_001)}</svg>`;
    expect(sanitizeSvg(many)).toBeNull();
  });

  it('keeps text only inside text elements', () => {
    const out = sanitizeSvg(`<svg ${NS}>stray<text x="1">Hello</text></svg>`) ?? '';
    expect(out).toContain('<text x="1">Hello</text>');
    expect(out).not.toContain('stray');
  });

  it('leaves the default logo unchanged in substance', () => {
    const out = sanitizeSvg(DEFAULT_PDF_LOGO_SVG) ?? '';
    expect(out).toContain('mask="url(#ringgaps)"');
    expect(out.match(/<path /g)).toHaveLength(2);
    expect(sanitizeSvg(out)).toBe(out);
  });
});

describe('decodePdfLogo and normalizePdfLogo', () => {
  it('accepts a base64 or URL-encoded SVG and stores it sanitized as base64', () => {
    const svg = `<svg ${NS}><rect width="1" height="1" onclick="x()"/></svg>`;
    const fromBase64 = normalizePdfLogo(`data:image/svg+xml;base64,${b64(svg)}`);
    const fromText = normalizePdfLogo(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    expect(fromBase64).toBe(fromText);
    expect(fromBase64?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const stored = Buffer.from((fromBase64 ?? '').split(',')[1] ?? '', 'base64').toString();
    expect(stored).not.toContain('onclick');
  });

  it('accepts a PNG with its signature', () => {
    expect(normalizePdfLogo(`data:image/png;base64,${PNG_1X1}`)).toBe(
      `data:image/png;base64,${PNG_1X1}`,
    );
    expect(normalizePdfLogo(`data:image/png;base64,${b64('not a png')}`)).toBeNull();
  });

  it('accepts an empty string as the default and rejects other formats', () => {
    expect(normalizePdfLogo('')).toBe('');
    expect(normalizePdfLogo(null)).toBeNull();
    expect(normalizePdfLogo('https://x.test/logo.png')).toBeNull();
    expect(normalizePdfLogo(`data:image/gif;base64,${b64('GIF89a')}`)).toBeNull();
    expect(normalizePdfLogo(`data:image/jpeg;base64,${b64('\xff\xd8\xff')}`)).toBeNull();
    expect(normalizePdfLogo('data:image/svg+xml,%E0%A4%A')).toBeNull();
  });

  it('rejects a file over the size limit', () => {
    const big = Buffer.alloc(MAX_PDF_LOGO_BYTES + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    expect(normalizePdfLogo(`data:image/png;base64,${big.toString('base64')}`)).toBeNull();
  });

  it('decodes a JPEG only when rendering allows it', () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64')}`;
    expect(decodePdfLogo(jpeg)).toBeNull();
    expect(decodePdfLogo(jpeg, { allowJpeg: true })?.kind).toBe('jpeg');
  });
});

describe('default PDF logo', () => {
  it('is one SVG with the mark and the wordmark as paths, no text or fonts', () => {
    expect(DEFAULT_PDF_LOGO_SVG).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    expect(DEFAULT_PDF_LOGO_SVG).toContain('<circle');
    expect(DEFAULT_PDF_LOGO_SVG).not.toMatch(/<text|font-family|<image|href=/);
    expect(decodePdfLogo(defaultPdfLogoDataUri())?.kind).toBe('svg');
  });
});

describe('normalizePdfFooter', () => {
  it('normalizes line breaks, trims and drops control characters', () => {
    expect(normalizePdfFooter('\r\n  \nEVtivity Inc.  \r\n1 Main St\tSuite 2\u0007\n\n')).toBe(
      'EVtivity Inc.\n1 Main St Suite 2',
    );
    expect(normalizePdfFooter('')).toBe('');
  });

  it('rejects non-strings, too long and too many lines', () => {
    expect(normalizePdfFooter(5)).toBeNull();
    expect(normalizePdfFooter('a'.repeat(MAX_PDF_FOOTER_LENGTH + 1))).toBeNull();
    expect(normalizePdfFooter('a\nb\nc\nd\ne\nf')).toBeNull();
    expect(normalizePdfFooter('a\nb\nc\nd\ne')).toBe('a\nb\nc\nd\ne');
  });
});
