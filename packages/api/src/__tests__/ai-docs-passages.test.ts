// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DOCS_PASSAGES_VERSION,
  HeadingSlugger,
  MAX_SECTION_CHARS,
  buildDocsPassages,
  mdxToPage,
  serializeDocsPassages,
  slugifyHeading,
  splitSectionText,
} from '../services/ai/docs/passages.js';

const PAGE = `---
title: Sessions
description: Monitor charging sessions.
---

import { Callout } from '~/components/callout';

Sessions are charging transactions.

![Sessions list](/screenshots/csms/sessions-list.png)

## Session List

The list has filters. See [Billing](#billing-a-session) and **Manual billing**.

<Callout type="note">
Free vend sessions show a &quot;Free Vend&quot; label.
</Callout>

### Station cost (OCPP 2.1)

\`\`\`bash
## not a heading
curl /v1/sessions
\`\`\`

#### Details

Deeper heading text stays in its section.

## Overview

First.

## Overview

Second.
`;

describe('docs passages generator', () => {
  it('slugs headings like the website (rehype-slug)', () => {
    expect(slugifyHeading('Billing a Session the CSMS Could Not End')).toBe(
      'billing-a-session-the-csms-could-not-end',
    );
    expect(slugifyHeading('Station cost (OCPP 2.1)')).toBe('station-cost-ocpp-21');
    expect(slugifyHeading('Überblick')).toBe('überblick');
    expect(slugifyHeading('会话列表')).toBe('会话列表');
    const slugger = new HeadingSlugger();
    expect(['Overview', 'Overview', 'Overview-1', 'Overview'].map((h) => slugger.slug(h))).toEqual([
      'overview',
      'overview-1',
      'overview-1-1',
      'overview-2',
    ]);
  });

  it('cuts a page into sections at ## and ###, with clean text', () => {
    const page = mdxToPage('/docs/csms/sessions', PAGE);
    expect(page?.title).toBe('Sessions');
    expect(page?.sections.map((s) => [s.anchor, s.heading])).toEqual([
      ['', 'Sessions'],
      ['session-list', 'Session List'],
      ['station-cost-ocpp-21', 'Station cost (OCPP 2.1)'],
      ['overview', 'Overview'],
      ['overview-1', 'Overview'],
    ]);
    const [intro, list, cost] = page?.sections ?? [];
    expect(intro?.text).toBe('Sessions are charging transactions.');
    expect(list?.text).toBe(
      'The list has filters. See Billing and Manual billing.\n\nFree vend sessions show a "Free Vend" label.',
    );
    // Code blocks are kept as they are; a deeper heading stays a line of its section.
    expect(cost?.text).toContain('## not a heading\ncurl /v1/sessions');
    expect(cost?.text).toContain('Details\n\nDeeper heading text stays in its section.');
  });

  it('skips a page without a title', () => {
    expect(mdxToPage('/docs/x', '## Only a heading\n\ntext')).toBeNull();
  });

  it('strips nested tag fragments completely', () => {
    const page = mdxToPage(
      '/docs/x',
      '---\ntitle: X\n---\n\nSafe <scr<b>ipt>alert(1)</scr</b>ipt> text <<i>b>bold<</i>/b>.',
    );
    const text = page?.sections[0]?.text ?? '';
    expect(text).not.toMatch(/<\/?[A-Za-z]/);
    // A single pass left `<b>bold</b>` behind.
    expect(text).toBe('Safe ipt>alert(1)ipt> text bold.');
  });

  it('splits a long section at paragraphs, every part within the limit', () => {
    const paragraph = 'word '.repeat(150).trim();
    const parts = splitSectionText(Array.from({ length: 8 }, () => paragraph).join('\n\n'));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_SECTION_CHARS);
    expect(splitSectionText('short')).toEqual(['short']);
    const one = splitSectionText('x'.repeat(MAX_SECTION_CHARS * 2 + 5));
    expect(one.map((p) => p.length)).toEqual([MAX_SECTION_CHARS, MAX_SECTION_CHARS, 5]);
  });

  describe('a docs tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-passages-'));
    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('reads every language folder into one page-per-line file', () => {
      mkdirSync(join(root, 'en', 'csms'), { recursive: true });
      mkdirSync(join(root, 'de', 'csms'), { recursive: true });
      writeFileSync(join(root, 'en', 'csms', 'sessions.mdx'), PAGE);
      writeFileSync(
        join(root, 'en', 'csms', 'sites.mdx'),
        '---\ntitle: Sites\n---\n\n## Overview\n\nA site.\n',
      );
      writeFileSync(
        join(root, 'de', 'csms', 'sites.mdx'),
        '---\ntitle: Standorte\n---\n\n## Überblick\n\nEin Standort.\n',
      );
      const file = buildDocsPassages(root);
      expect(file.version).toBe(DOCS_PASSAGES_VERSION);
      expect(Object.keys(file.languages)).toEqual(['en', 'de']);
      expect(file.languages['en']?.map((p) => p.path)).toEqual([
        '/docs/csms/sessions',
        '/docs/csms/sites',
      ]);
      expect(file.languages['de']?.[0]?.sections[0]).toEqual({
        anchor: 'überblick',
        heading: 'Überblick',
        text: 'Ein Standort.',
      });
      const text = serializeDocsPassages(file);
      expect(JSON.parse(text)).toEqual(file);
      expect(text.split('\n').filter((l) => l.startsWith('{"path":'))).toHaveLength(3);
    });

    it('needs English pages', () => {
      const empty = mkdtempSync(join(tmpdir(), 'docs-passages-empty-'));
      try {
        expect(() => buildDocsPassages(empty)).toThrow(/No English docs pages/);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});
