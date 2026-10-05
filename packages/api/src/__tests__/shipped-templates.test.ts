// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import { describe, it, expect } from 'vitest';
import { assertTemplateAllowed, compileAllowedTemplate } from '@evtivity/lib';

const API_TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url));
const OCPP_TEMPLATES_DIR = fileURLToPath(new URL('../../../ocpp/src/templates', import.meta.url));
const TEMPLATE_DIRS = [API_TEMPLATES_DIR, OCPP_TEMPLATES_DIR];
const PACKAGES_DIR = fileURLToPath(new URL('../../..', import.meta.url));

// Every shipped template is localized into each language the dashboards ship.
const TRANSLATED_LANGUAGES = ['de', 'es', 'ko', 'zh', 'zh-TW'];

function listTemplates(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTemplates(path);
    return entry.name.endsWith('.hbs') ? [path] : [];
  });
}

function variableNames(source: string): string[] {
  return [...source.matchAll(/\{\{\{?[#^/]?(?:if |unless )?\s*([A-Za-z_][\w.]*)/g)]
    .map((m) => m[1] ?? '')
    .filter((n) => n !== 'else' && n !== 'if' && n !== 'unless');
}

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();
const tagSequence = (source: string): string[] =>
  [...source.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[0]);
const links = (source: string): string[] =>
  [...source.matchAll(/href=(['"])(.*?)\1/g)].map((m) => m[2] ?? '');

describe('shipped notification templates', () => {
  const files = TEMPLATE_DIRS.flatMap((dir) => listTemplates(dir).map((file) => ({ dir, file })));

  it('finds the template files', () => {
    expect(listTemplates(API_TEMPLATES_DIR).length).toBeGreaterThan(100);
    expect(listTemplates(OCPP_TEMPLATES_DIR).length).toBeGreaterThan(500);
  });

  it.each(files.map(({ file }) => [relative(PACKAGES_DIR, file), file]))(
    '%s passes the operator template rules and renders like Handlebars',
    (_name, file) => {
      const source = readFileSync(file, 'utf-8');
      expect(() => {
        assertTemplateAllowed(source);
      }).not.toThrow();
      // Every variable set, then none set, so both sides of each {{#if}} render.
      const all = Object.fromEntries(variableNames(source).map((n) => [n, `<${n}> & "x"`]));
      for (const vars of [all, {}]) {
        expect(compileAllowedTemplate(source)(vars)).toBe(Handlebars.compile(source)(vars));
      }
    },
  );
});

describe('notification template translations', () => {
  const pairs = TEMPLATE_DIRS.flatMap((dir) =>
    listTemplates(join(dir, 'en')).flatMap((enFile) => {
      const rel = relative(join(dir, 'en'), enFile);
      return TRANSLATED_LANGUAGES.map((lang) => ({
        name: relative(PACKAGES_DIR, join(dir, lang, rel)),
        enFile,
        file: join(dir, lang, rel),
      }));
    }),
  );

  it('has no template in a language folder that en lacks', () => {
    for (const dir of TEMPLATE_DIRS) {
      const enFiles = new Set(
        listTemplates(join(dir, 'en')).map((f) => relative(join(dir, 'en'), f)),
      );
      for (const lang of TRANSLATED_LANGUAGES) {
        const extra = listTemplates(join(dir, lang))
          .map((f) => relative(join(dir, lang), f))
          .filter((rel) => !enFiles.has(rel));
        expect(extra, `${dir} ${lang}`).toEqual([]);
      }
    }
  });

  it('keeps an event that both template directories ship identical in every language', () => {
    const [apiDir, ocppDir] = [API_TEMPLATES_DIR, OCPP_TEMPLATES_DIR];
    const differing = ['en', ...TRANSLATED_LANGUAGES].flatMap((lang) =>
      listTemplates(join(apiDir, lang))
        .map((f) => relative(join(apiDir, lang), f))
        .filter((rel) => existsSync(join(ocppDir, lang, rel)))
        .filter(
          (rel) =>
            readFileSync(join(apiDir, lang, rel), 'utf-8') !==
            readFileSync(join(ocppDir, lang, rel), 'utf-8'),
        )
        .map((rel) => `${lang}/${rel}`),
    );
    expect(differing).toEqual([]);
  });

  it.each(pairs.map((p) => [p.name, p]))(
    '%s exists, is translated, and keeps the variables, tags and links of en',
    (_name, { enFile, file }) => {
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const en = readFileSync(enFile, 'utf-8');
      const translated = readFileSync(file, 'utf-8');
      expect(translated).not.toBe(en);
      expect(uniqueSorted(variableNames(translated))).toEqual(uniqueSorted(variableNames(en)));
      expect(tagSequence(translated)).toEqual(tagSequence(en));
      expect(links(translated)).toEqual(links(en));
    },
  );
});

// GSM 03.38 basic set plus the escaped extension characters (2 septets each).
const GSM7 = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM7_EXT = new Set('^{}\\[~]|€');

// SMS parts for a template, counting each variable as 10 characters and both
// sides of every {{#if}} as sent. One accented vowel outside GSM-7 (á, í, ó, ú)
// switches the whole message to UCS-2: 70 characters per part instead of 160.
function smsParts(source: string): number {
  const text = source
    .replace(/\{\{[#/][^}]*\}\}|\{\{else\}\}/g, '')
    .replace(/\{\{\{?[^}]*\}?\}\}/g, 'x'.repeat(10))
    .trim();
  const chars = Array.from(text);
  if (chars.every((c) => GSM7.has(c) || GSM7_EXT.has(c))) {
    const septets = chars.reduce((n, c) => n + (GSM7_EXT.has(c) ? 2 : 1), 0);
    return septets <= 160 ? 1 : Math.ceil(septets / 153);
  }
  return chars.length <= 70 ? 1 : Math.ceil(chars.length / 67);
}

describe('notification SMS length', () => {
  const smsPairs = TEMPLATE_DIRS.flatMap((dir) =>
    listTemplates(join(dir, 'en'))
      .filter((f) => f.endsWith('/sms.hbs'))
      .flatMap((enFile) => {
        const rel = relative(join(dir, 'en'), enFile);
        return TRANSLATED_LANGUAGES.map((lang) => ({
          name: relative(PACKAGES_DIR, join(dir, lang, rel)),
          enFile,
          file: join(dir, lang, rel),
        }));
      }),
  );

  it.each(smsPairs.map((p) => [p.name, p]))(
    '%s needs no more SMS parts than en',
    (_name, { enFile, file }) => {
      const enParts = smsParts(readFileSync(enFile, 'utf-8'));
      expect(smsParts(readFileSync(file, 'utf-8'))).toBeLessThanOrEqual(enParts);
    },
  );
});

describe('notification subjects', () => {
  const eventDirs = TEMPLATE_DIRS.flatMap((dir) =>
    listTemplates(join(dir, 'en'))
      .filter((f) => f.endsWith('/email.hbs'))
      .map((f) => join(dir, 'en', relative(join(dir, 'en'), f).replace(/\/email\.hbs$/, ''))),
  );
  const subjectFiles = TEMPLATE_DIRS.flatMap((dir) =>
    ['en', ...TRANSLATED_LANGUAGES].flatMap((lang) =>
      listTemplates(join(dir, lang)).filter((f) => f.endsWith('/subject.hbs')),
    ),
  );

  it('has an en subject for every event with an email template', () => {
    const missing = eventDirs.filter((d) => !existsSync(join(d, 'subject.hbs')));
    expect(missing).toEqual([]);
  });

  it.each(subjectFiles.map((f) => [relative(PACKAGES_DIR, f), f]))(
    '%s is one line of plain text that starts with the company name',
    (_name, file) => {
      const source = readFileSync(file, 'utf-8').trim();
      expect(source).not.toContain('\n');
      expect(tagSequence(source)).toEqual([]);
      expect(source.startsWith('{{{companyName}}} - ')).toBe(true);
      // Subjects are plain text: triple-stache so an "&" is not HTML-escaped.
      expect(source.replace(/\{\{\{[A-Za-z_][\w.]*\}\}\}/g, '')).not.toContain('{{');
    },
  );
});

// Chinese terms: driver is 驾驶员 / 駕駛員 and firmware is 固件 in both scripts.
// Bare 驾驶 / 駕駛 passes only in its verb and compound senses (燃油驾驶避免,
// 驾驶里程, 副驾驶, 自动驾驶). The docs label check uses the same patterns.
const FORBIDDEN_ZH_TERMS: Record<string, RegExp> = {
  zh: /司机|驾驶人|韧体|(?<![副动])驾驶(?![员避里距不着车])/gu,
  'zh-TW': /司機|駕駛人|韌體|(?<![副動])駕駛(?![員避里距不著車])/gu,
};

describe('notification template terms', () => {
  const termFiles = Object.keys(FORBIDDEN_ZH_TERMS).flatMap((lang) =>
    TEMPLATE_DIRS.flatMap((dir) => {
      const langDir = join(dir, lang);
      return existsSync(langDir) ? listTemplates(langDir).map((file) => ({ lang, file })) : [];
    }),
  );

  it('finds the Chinese templates', () => {
    expect(termFiles.length).toBeGreaterThan(100);
  });

  it.each(termFiles.map(({ lang, file }) => [relative(PACKAGES_DIR, file), lang, file]))(
    '%s uses the driver and firmware terms',
    (_name, lang, file) => {
      const pattern = FORBIDDEN_ZH_TERMS[lang] ?? /$^/u;
      const found = [...readFileSync(file, 'utf-8').matchAll(pattern)].map((m) => m[0]);
      expect(found).toEqual([]);
    },
  );
});
