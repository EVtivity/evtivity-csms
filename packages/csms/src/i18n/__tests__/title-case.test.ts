// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// English UI labels use title case: every key under a label namespace (tabs,
// titles, nav, columns, headers) in the CSMS and portal en.json.

import { describe, expect, it } from 'vitest';
import csmsEn from '../locales/en.json';
import { AI_SETTINGS_TABS } from '../../components/settings/ai-settings-tabs';

const portalEn = JSON.parse(
  Object.values(
    import.meta.glob<string>('../../../../portal/src/i18n/locales/en.json', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0] ?? '{}',
) as unknown;

/** Short words that stay lowercase unless they come first. */
const MINOR_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'per',
  'x',
]);

/** Keys of label namespaces: tabs, titles, nav items, column and header labels. */
const LABEL_KEY =
  /(^|\.)tabs\.|[a-z]Tabs\.(?!.*(Description|Link)$)|(^|\.)title$|Title$|^nav\.|(^|\.)columns?\.|(^|\.)headers?\./;

/** Intentional exceptions: accessible names, tooltips and sentences, not visible labels. */
const ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  csms: new Set([
    'nav.unassignedCasesCount_one',
    'nav.unassignedCasesCount_other',
    'nav.collapseSidebar',
    'nav.expandSidebar',
    'nav.openMenu',
    'nav.closeMenu',
    'ai.explain.buttonTitle',
    'paymentProviders.upgradePending.title',
  ]),
  portal: new Set([]),
};

function isTitleCase(text: string): boolean {
  // Unit text in parentheses, such as "(kWh per day)", keeps its own case.
  const words = text
    .replace(/\([^)]*\)/g, '')
    .split(/\s+/)
    .filter((w) => w !== '' && !w.includes('{{'));
  return words.every((word, i) => {
    const core = word.replace(/^[^A-Za-z]+/, '');
    if (core === '') return true;
    // Units and brand spellings keep their case: kWh, eMAID, reCAPTCHA.
    if (/[a-z][A-Z]/.test(core)) return true;
    const bare = core.toLowerCase().replace(/[^a-z]/g, '');
    const last = i === words.length - 1;
    if (i > 0 && !last && MINOR_WORDS.has(bare)) return core === core.toLowerCase();
    return /^[A-Z0-9]/.test(core);
  });
}

/** A translated text that opens a title, heading, tab or column element in CSMS source. */
const TITLE_ELEMENT =
  /<(CardTitle|DialogTitle|AlertTitle|TabsTrigger|TableHead|BreadcrumbPage|h[1-4])\b[^>]*>\s*\{t\(\s*'([^']+)'/g;

function lookup(node: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (n, part) =>
        n != null && typeof n === 'object' ? (n as Record<string, unknown>)[part] : undefined,
      node,
    );
}

function labels(node: unknown, prefix = ''): [string, string][] {
  if (node == null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (typeof v === 'string') return LABEL_KEY.test(key) ? [[key, v] as [string, string]] : [];
    return labels(v, key);
  });
}

describe('title case for English UI labels', () => {
  it('the checker follows the rule', () => {
    expect(isTitleCase('Providers and Keys')).toBe(true);
    expect(isTitleCase('What the AI Provider Receives')).toBe(true);
    expect(isTitleCase('Left Off the Invoice ({{count}})')).toBe(true);
    expect(isTitleCase('Disable This Station?')).toBe(true);
    expect(isTitleCase('Providers and keys')).toBe(false);
    expect(isTitleCase('Usage And Limits')).toBe(false);
    expect(isTitleCase('Starts At')).toBe(true);
    expect(isTitleCase('Rate per kWh')).toBe(true);
    expect(isTitleCase('Energy (kWh per day)')).toBe(true);
    expect(isTitleCase('Active insights')).toBe(false);
  });

  it.each([
    ['csms', csmsEn],
    ['portal', portalEn],
  ] as const)('every %s label key is title case', (app, locale) => {
    const found = labels(locale);
    expect(found.length).toBeGreaterThan(20);
    const bad = found
      .filter(([key, text]) => !ALLOWED[app]?.has(key) && !isTitleCase(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(bad).toEqual([]);
  });

  it('the Settings > AI tab labels are title case', () => {
    for (const tab of AI_SETTINGS_TABS) {
      expect(isTitleCase(csmsEn.settings.aiTabs[tab]), tab).toBe(true);
    }
    expect(csmsEn.settings.aiTabs.providers).toBe('Providers and Keys');
  });

  it('every key rendered as a title, heading, tab or column is title case', () => {
    const sources = import.meta.glob<string>(['../../**/*.tsx', '!../../**/__tests__/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const rendered = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(TITLE_ELEMENT)) if (m[2] != null) rendered.add(m[2]);
    }
    expect(rendered.size).toBeGreaterThan(50);
    const bad = [...rendered]
      .filter((key) => !ALLOWED['csms']?.has(key))
      .map((key) => [key, lookup(csmsEn, key)] as const)
      .filter(([, text]) => typeof text === 'string' && !isTitleCase(text))
      .map(([key, text]) => `${key}: ${String(text)}`);
    expect(bad).toEqual([]);
  });

  it('a details tab is named plain Details, never "<Entity> Details"', () => {
    const sources = import.meta.glob<string>(['../../**/*.tsx', '!../../**/__tests__/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const tabKeys = new Set<string>();
    for (const text of Object.values(sources)) {
      for (const m of text.matchAll(/<TabsTrigger\b[^>]*>\s*\{t\(\s*'([^']+)'/g)) {
        if (m[1] != null) tabKeys.add(m[1]);
      }
    }
    expect(tabKeys.size).toBeGreaterThan(20);
    const bad = [...tabKeys]
      .map((key) => [key, lookup(csmsEn, key)] as const)
      .filter(([, text]) => typeof text === 'string' && / Details$/.test(text))
      .map(([key, text]) => `${key}: ${String(text)}`);
    expect(bad).toEqual([]);
  });

  it('allowlisted keys still exist, so the allowlist cannot go stale', () => {
    const keys = new Set(labels(csmsEn).map(([key]) => key));
    for (const key of ALLOWED['csms'] ?? []) expect(keys.has(key), key).toBe(true);
  });
});
