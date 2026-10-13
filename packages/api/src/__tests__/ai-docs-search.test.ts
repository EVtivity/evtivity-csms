// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const userLanguage = vi.hoisted((): { value: string | null } => ({ value: 'de' }));

vi.mock('@evtivity/database', () => ({
  users: { id: 'id', language: 'language' },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(userLanguage.value === null ? [] : [{ language: userLanguage.value }]),
        }),
      }),
    }),
  },
}));

import {
  corpusFromFile,
  docsPassageUrl,
  docsSearchResponseIds,
  isDocsCitationUrl,
  searchDocs,
  searchResultsForIds,
  setDocsCorpusForTests,
  tokenize,
} from '../services/ai/docs/docs-search.js';
import type { DocsPassagesFile } from '../services/ai/docs/passages.js';
import { docsSearchRoutes } from '../routes/docs-search.js';
import { validCitations } from '../services/ai/engine/turn-runner.js';

const FILE: DocsPassagesFile = {
  version: 2,
  languages: {
    en: [
      {
        path: '/docs/csms/settings',
        title: 'Settings',
        sections: [
          {
            anchor: 'company',
            heading: 'Company',
            text: 'Set the company currency and the company name.',
          },
          { anchor: 'security', heading: 'Security', text: 'Turn on reCAPTCHA and MFA.' },
        ],
      },
      {
        path: '/docs/csms/sites',
        title: 'Sites',
        sections: [{ anchor: '', heading: 'Sites', text: 'A site groups stations.' }],
      },
      // A path that is no docs page path is never loaded.
      {
        path: '/evil/../x',
        title: 'Bad',
        sections: [{ anchor: '', heading: 'Bad', text: 'currency' }],
      },
    ],
    de: [
      {
        path: '/docs/csms/settings',
        title: 'Einstellungen',
        sections: [
          {
            anchor: 'unternehmen',
            heading: 'Unternehmen',
            text: 'Legen Sie die Währung des Unternehmens fest.',
          },
        ],
      },
    ],
    zh: [
      {
        path: '/docs/csms/sessions',
        title: '会话',
        sections: [{ anchor: '会话列表', heading: '会话列表', text: '会话列表显示所有充电会话。' }],
      },
    ],
  },
};

const corpus = corpusFromFile(FILE);

describe('docs search (TC-AI-M-06)', () => {
  it('numbers passages in file order and skips invalid paths', () => {
    expect([...corpus.byId.keys()]).toEqual(['1', '2', '3', '4', '5']);
    expect(corpus.byId.get('3')?.path).toBe('/docs/csms/sites');
    expect([...corpus.byId.values()].some((p) => p.path.includes('evil'))).toBe(false);
  });

  it('tokenizes words and CJK character pairs', () => {
    expect(tokenize('How do I change the Currency?')).toEqual(['change', 'currency']);
    expect(tokenize('会话列表')).toEqual(['会话', '话列', '列表']);
    expect(tokenize('OCPP 会话')).toEqual(['ocpp', '会话']);
  });

  it('returns the best passages in the language, with ids and website URLs', () => {
    const result = searchDocs('company currency', 'en', 5, corpus);
    expect(result.language).toBe('en');
    expect(result.fallback).toBe(false);
    expect(result.results[0]).toEqual({
      id: '1',
      title: 'Settings - Company',
      url: 'https://evtivity.com/docs/csms/settings#company',
      text: 'Set the company currency and the company name.',
    });
    expect(searchDocs('Währung', 'de', 5, corpus).results[0]?.url).toBe(
      'https://evtivity.com/de/docs/csms/settings#unternehmen',
    );
    expect(searchDocs('会话列表', 'zh', 5, corpus).results[0]?.url).toBe(
      `https://evtivity.com/zh/docs/csms/sessions#${encodeURIComponent('会话列表')}`,
    );
  });

  it('falls back to English when the language has no match or no docs', () => {
    const de = searchDocs('reCAPTCHA', 'de', 5, corpus);
    expect(de.fallback).toBe(true);
    expect(de.language).toBe('en');
    expect(de.results.map((r) => r.id)).toEqual(['2']);
    expect(searchDocs('stations', 'ko', 5, corpus).results.map((r) => r.id)).toEqual(['3']);
  });

  it('returns nothing for a query without terms, and caps the limit', () => {
    expect(searchDocs('the a to', 'en', 5, corpus).results).toEqual([]);
    expect(searchDocs('company currency security site', 'en', 1, corpus).results).toHaveLength(1);
  });

  it('builds URLs only for docs paths and allowlists only website docs URLs', () => {
    expect(docsPassageUrl({ language: 'zh-TW', path: '/docs/csms/sites', anchor: '' })).toBe(
      'https://evtivity.com/zh-TW/docs/csms/sites',
    );
    expect(docsPassageUrl({ language: 'en', path: '/docs/../admin', anchor: '' })).toBeNull();
    expect(isDocsCitationUrl('https://evtivity.com/docs/csms/sites#overview')).toBe(true);
    expect(isDocsCitationUrl('https://evtivity.com/ko/docs/csms/sites')).toBe(true);
    expect(isDocsCitationUrl('https://evtivity.com/blog/post')).toBe(false);
    expect(isDocsCitationUrl('http://evtivity.com/docs/csms/sites')).toBe(false);
    expect(isDocsCitationUrl('https://evtivity.com.example.com/docs/csms')).toBe(false);
    expect(isDocsCitationUrl('https://user@evtivity.com/docs/csms')).toBe(false);
    expect(isDocsCitationUrl('javascript:alert(1)')).toBe(false);
  });

  it('rebuilds the passages a response named from the corpus, never from the body', () => {
    const ids = docsSearchResponseIds({
      results: [{ id: '1', url: 'https://example.com', text: 'forged' }, { id: '42' }, {}],
    });
    expect(searchResultsForIds(ids, corpus)).toEqual([
      {
        id: '1',
        title: 'Settings - Company',
        url: 'https://evtivity.com/docs/csms/settings#company',
        text: 'Set the company currency and the company name.',
      },
    ]);
    expect(docsSearchResponseIds('not json')).toEqual([]);
  });

  it('validates cited ids against the passages of the turn', () => {
    const passages = new Map(searchResultsForIds(['1', '3'], corpus).map((p) => [p.id, p]));
    expect(
      validCitations(
        [{ passageId: '3' }, { passageId: '9' }, { passageId: '3' }, { passageId: '1' }],
        passages,
      ).map((c) => c.id),
    ).toEqual(['3', '1']);
  });
});

describe('GET /docs/search', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    setDocsCorpusForTests(corpus);
    app = Fastify();
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.user = { userId: 'usr_000000000001', roleId: 'rol_000000000001' };
      return Promise.resolve();
    });
    docsSearchRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    setDocsCorpusForTests(null);
    await app.close();
  });

  afterEach(() => {
    userLanguage.value = 'de';
  });

  it("searches in the user's language by default", async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/search?query=W%C3%A4hrung' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ language: 'de', fallback: false, results: [{ id: '4' }] });
  });

  it('takes an explicit language and limit, and English for an unknown user language', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/docs/search?query=company&language=en&limit=1',
    });
    expect(res.json<{ results: unknown[] }>().results).toHaveLength(1);
    userLanguage.value = 'fr';
    const fallback = await app.inject({ method: 'GET', url: '/docs/search?query=company' });
    expect(fallback.json()).toMatchObject({ language: 'en', fallback: false });
  });

  it('refuses an empty query and an unknown language', async () => {
    expect((await app.inject({ method: 'GET', url: '/docs/search?query=' })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/docs/search?query=x&language=fr' })).statusCode,
    ).toBe(400);
  });
});
