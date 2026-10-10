// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The print utility classes in index.css. jsdom does not evaluate media
// queries, so the rules are read from the stylesheet itself.

import { describe, it, expect } from 'vitest';
import css from '../../index.css?raw';

/** The bodies of every top-level `@media <query> { ... }` block for one query. */
function mediaBlocks(query: string): string[] {
  const blocks: string[] = [];
  const head = `@media ${query} {`;
  let from = css.indexOf(head);
  while (from !== -1) {
    let depth = 1;
    let i = from + head.length;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push(css.slice(from + head.length, i - 1));
    from = css.indexOf(head, i);
  }
  return blocks;
}

/** The declarations of `selector` inside a CSS block, or null when it has no rule. */
function ruleBody(block: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[\\s,}])${escaped}\\s*\\{([^}]*)\\}`).exec(block);
  return match?.[1] ?? null;
}

describe('print utility classes', () => {
  it('reads the stylesheet', () => {
    expect(css.length).toBeGreaterThan(1000);
  });

  it('hides .print-only everywhere except print', () => {
    const rules = mediaBlocks('not print')
      .map((block) => ruleBody(block, '.print-only'))
      .filter((body) => body != null);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatch(/display:\s*none\s*!important/);
  });

  it('never hides .print-only in the print layout', () => {
    for (const block of mediaBlocks('print')) {
      expect(ruleBody(block, '.print-only')).toBeNull();
    }
    // Outside any media query it would hide the logo in print too.
    const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
    expect(ruleBody(topLevel, '.print-only')).toBeNull();
  });

  it('prints no address after an app link', () => {
    for (const block of mediaBlocks('print')) {
      expect(ruleBody(block, 'a[href]::after')).toBeNull();
      expect(block).not.toMatch(/a\[href\][^{]*::after/);
    }
  });

  it('prints links in the invoice as plain text', () => {
    const after = mediaBlocks('print')
      .map((block) => ruleBody(block, '.invoice-print-area a::after'))
      .filter((body) => body != null);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatch(/content:\s*none\s*!important/);
    const link = mediaBlocks('print')
      .map((block) => ruleBody(block, '.invoice-print-area a'))
      .filter((body) => body != null);
    expect(link).toHaveLength(1);
    expect(link[0]).toMatch(/color:\s*inherit\s*!important/);
    expect(link[0]).toMatch(/text-decoration:\s*none\s*!important/);
  });

  it('hides .print-hidden in the print layout', () => {
    const rules = mediaBlocks('print')
      .map((block) => ruleBody(block, '.print-hidden'))
      .filter((body) => body != null);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0]).toMatch(/display:\s*none\s*!important/);
  });
});
