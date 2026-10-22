// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The SIM provider settings and the station Connectivity tab have every text in
// all six languages, with the same interpolation variables as English.

import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';

const OTHER_LOCALES: Record<string, unknown> = { de, es, ko, zh, 'zh-TW': zhTW };

const ROOTS = ['settings.sim', 'stations.sim', 'stations.simCoverage'];

function lookup(messages: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node != null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages,
    );
}

function leaves(node: unknown, prefix: string): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (node == null || typeof node !== 'object') return [];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    leaves(value, `${prefix}.${key}`),
  );
}

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1] ?? '').sort();
}

describe('SIM locale keys', () => {
  for (const root of ROOTS) {
    const english = leaves(lookup(en, root), root);

    it(`has English texts under ${root}`, () => {
      expect(english.length).toBeGreaterThan(0);
    });

    for (const [lang, messages] of Object.entries(OTHER_LOCALES)) {
      it(`has every ${root} text in ${lang} with the same variables`, () => {
        for (const [key, text] of english) {
          const translated = lookup(messages, key);
          expect(typeof translated, `${lang} ${key}`).toBe('string');
          expect((translated as string).trim(), `${lang} ${key}`).not.toBe('');
          expect(variables(translated as string), `${lang} ${key}`).toEqual(variables(text));
        }
        expect(leaves(lookup(messages, root), root).length, `${lang} ${root}`).toBe(english.length);
      });
    }
  }
});
