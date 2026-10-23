// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { EMAIL_PREVIEW_CSP, emailPreviewDocument } from '../email-preview';

// Every CSMS component except tests.
const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const META = `<meta http-equiv="Content-Security-Policy" content="${EMAIL_PREVIEW_CSP}">`;

describe('emailPreviewDocument', () => {
  it('blocks remote resources: only inline styles and data images load', () => {
    expect(EMAIL_PREVIEW_CSP).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  });

  it('puts the policy right after the doctype of a full document', () => {
    const html =
      '<!DOCTYPE html><html><head lang="en"><style>p{}</style></head><body><img src="https://x.example/t.gif"></body></html>';
    expect(emailPreviewDocument(html)).toBe(
      `<!DOCTYPE html>${META}<html><head lang="en"><style>p{}</style></head><body><img src="https://x.example/t.gif"></body></html>`,
    );
  });

  // An earlier "<head" in a comment, an attribute or after body content no
  // longer moves the policy there.
  it.each([
    '<!-- <head> --><img src="https://x.test/p">',
    '<img src="https://x.test/p"><html><head></head></html>',
    '<p title="<head>">x</p><img src="https://x.test/p">',
  ])('puts the policy before every element of %s', (html) => {
    const doc = emailPreviewDocument(html);
    expect(doc.startsWith(META)).toBe(true);
    expect(new DOMParser().parseFromString(doc, 'text/html').head.innerHTML).toContain(
      'Content-Security-Policy',
    );
  });

  it('prepends the policy to a fragment without a head', () => {
    expect(emailPreviewDocument('<p>Hi</p>')).toBe(`${META}<p>Hi</p>`);
  });

  it('does not take a header element for the head', () => {
    expect(emailPreviewDocument('<header>x</header>')).toBe(`${META}<header>x</header>`);
  });

  it('every srcDoc in the CSMS goes through it', () => {
    let previews = 0;
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(SOURCES)) {
      for (const match of source.matchAll(/srcDoc=\{([^\n]*)/g)) {
        previews++;
        if (!match[1]?.startsWith('emailPreviewDocument(')) offenders.push(file);
      }
    }
    expect(previews).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
