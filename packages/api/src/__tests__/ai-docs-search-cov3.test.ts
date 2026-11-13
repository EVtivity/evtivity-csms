// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  corpusFromFile,
  docsCorpus,
  docsPassagesPath,
  docsSearchResponseIds,
  isDocsCitationUrl,
  passageTitle,
  searchDocs,
  searchResultsForIds,
  setDocsCorpusForTests,
  tokenize,
  toSearchResult,
} from '../services/ai/docs/docs-search.js';
import type { DocsPassage } from '../services/ai/docs/docs-search.js';

let dir = '';
const previousEnv = process.env['DOCS_INDEX_PATH'];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docs-search-cov3-'));
});

afterEach(() => {
  setDocsCorpusForTests(null);
  if (previousEnv === undefined) delete process.env['DOCS_INDEX_PATH'];
  else process.env['DOCS_INDEX_PATH'] = previousEnv;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FILE = {
  version: 2,
  languages: {
    en: [
      {
        path: '/docs/csms/stations',
        title: 'Stations',
        sections: [
          { heading: 'Stations', anchor: '', text: 'Add a charging station to a site.' },
          { heading: 'Reset', anchor: 'reset', text: 'Reset a station remotely.' },
        ],
      },
    ],
    de: [
      {
        path: '/docs/csms/stations',
        title: 'Ladestationen',
        sections: [{ heading: 'Neustart', anchor: 'neustart', text: 'Station neu starten.' }],
      },
    ],
  },
};

describe('docsCorpus loading', () => {
  it('derives the passages path from DOCS_INDEX_PATH or the working directory', () => {
    expect(docsPassagesPath({ DOCS_INDEX_PATH: '/app/x/docs-index.json' })).toBe(
      '/app/x/docs-passages.json',
    );
    expect(docsPassagesPath({})).toBe(join(process.cwd(), 'docs-passages.json'));
  });

  it('reads the passages file once and numbers its passages', () => {
    writeFileSync(join(dir, 'docs-passages.json'), JSON.stringify(FILE));
    process.env['DOCS_INDEX_PATH'] = join(dir, 'docs-index.json');
    setDocsCorpusForTests(null);
    const corpus = docsCorpus();
    expect(corpus.byId.size).toBe(3);
    expect(docsCorpus()).toBe(corpus);
    const result = searchDocs('reset', 'en');
    expect(result.results[0]?.url).toBe('https://evtivity.com/docs/csms/stations#reset');
  });

  it('is empty for a missing file and for a file of another version', () => {
    process.env['DOCS_INDEX_PATH'] = join(dir, 'missing', 'docs-index.json');
    setDocsCorpusForTests(null);
    expect(docsCorpus().byId.size).toBe(0);

    const other = mkdtempSync(join(tmpdir(), 'docs-search-cov3-v1-'));
    writeFileSync(join(other, 'docs-passages.json'), JSON.stringify({ version: 1, languages: {} }));
    process.env['DOCS_INDEX_PATH'] = join(other, 'docs-index.json');
    setDocsCorpusForTests(null);
    expect(docsCorpus().byId.size).toBe(0);

    writeFileSync(join(other, 'docs-passages.json'), 'not json');
    setDocsCorpusForTests(null);
    expect(docsCorpus().byId.size).toBe(0);
    rmSync(other, { recursive: true, force: true });
  });
});

describe('passages and URLs', () => {
  const passage: DocsPassage = {
    id: '1',
    language: 'de',
    path: '/docs/csms/stations',
    pageTitle: 'Ladestationen',
    heading: 'Neustart',
    anchor: 'neustart',
    text: 't',
  };

  it('titles a section by page and heading, a page section by page only', () => {
    expect(passageTitle(passage)).toBe('Ladestationen - Neustart');
    expect(passageTitle({ ...passage, anchor: '' })).toBe('Ladestationen');
    expect(passageTitle({ ...passage, heading: 'Ladestationen' })).toBe('Ladestationen');
    expect(passageTitle({ ...passage, pageTitle: 'x'.repeat(600) })).toHaveLength(500);
  });

  it('prefixes the language of a non-English passage and refuses a bad path', () => {
    expect(toSearchResult(passage)?.url).toBe(
      'https://evtivity.com/de/docs/csms/stations#neustart',
    );
    expect(toSearchResult({ ...passage, path: '/blog/x' })).toBeNull();
    expect(toSearchResult({ ...passage, language: 'fr' as never })).toBeNull();
  });

  it('accepts only docs URLs on the website', () => {
    expect(isDocsCitationUrl('https://evtivity.com/docs/csms/stations#a')).toBe(true);
    expect(isDocsCitationUrl('https://evtivity.com/zh-TW/docs/csms')).toBe(true);
    expect(isDocsCitationUrl('https://evtivity.com/docs/csms?x=1')).toBe(false);
    expect(isDocsCitationUrl('https://u:p@evtivity.com/docs/csms')).toBe(false);
    expect(isDocsCitationUrl('https://evil.com/docs/csms')).toBe(false);
    expect(isDocsCitationUrl('https://evtivity.com/blog/x')).toBe(false);
    expect(isDocsCitationUrl('not a url')).toBe(false);
  });
});

describe('search', () => {
  it('tokenizes mixed Latin and CJK runs and single CJK characters', () => {
    expect(tokenize('OCPP充电桩')).toEqual(['ocpp', '充电', '电桩']);
    expect(tokenize('a桩')).toEqual(['桩']);
    expect(tokenize('stations the to')).toEqual(['station']);
  });

  it('falls back to English when the language finds nothing', () => {
    const corpus = corpusFromFile(FILE as never);
    expect(searchDocs('reset', 'de', 5, corpus)).toMatchObject({ language: 'en', fallback: true });
    expect(searchDocs('neustart', 'de', 0, corpus)).toMatchObject({
      language: 'de',
      fallback: false,
    });
    expect(searchDocs('nothing here', 'en', 5, corpus).results).toEqual([]);
  });

  it('rebuilds results for ids once each, skipping unknown and non-string ids', () => {
    const corpus = corpusFromFile(FILE as never);
    expect(searchResultsForIds(['2', '2', 9, '99'], corpus).map((r) => r.id)).toEqual(['2']);
  });

  it('reads the ids of a response body', () => {
    expect(docsSearchResponseIds({ results: [{ id: '1' }, 'x', null] })).toEqual([
      '1',
      undefined,
      undefined,
    ]);
    expect(docsSearchResponseIds(null)).toEqual([]);
    expect(docsSearchResponseIds({ results: 'x' })).toEqual([]);
  });
});
