// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { permissionCatalog } from '@evtivity/lib/permissions';
import en from '../locales/en.json';
import de from '../locales/de.json';
import es from '../locales/es.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';

const LOCALES: Record<string, unknown> = { en, de, es, ko, zh, 'zh-TW': zhTW };

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

describe('permission editor labels', () => {
  const keys = [
    ...permissionCatalog.groups().map((g) => g.labelKey),
    'users.permissionRead',
    'users.permissionWrite',
  ];

  for (const [lang, messages] of Object.entries(LOCALES)) {
    it(`translates every permission group label in ${lang}`, () => {
      const missing = keys.filter((key) => {
        const value = lookup(messages, key);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }
});
