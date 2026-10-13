// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * `docs_search`: a local search over the documentation passages
 * (`docs-passages.json`, next to `docs-index.json`: the working directory,
 * `/app` in the API image, or the folder of `DOCS_INDEX_PATH`). No provider
 * or network call: the passages are public website text.
 *
 * Every passage gets a numeric id when the file is loaded (file order, so
 * every pod of one image numbers them the same). The engine accepts a
 * citation only for an id a `docs_search` call returned in the same turn,
 * and builds its link here, from the passage, never from model text.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AiSearchResult } from '@evtivity/ai/core';
import { createLogger, tryParseJson } from '@evtivity/lib';
import { DOCS_LANGUAGES, DOCS_PASSAGES_VERSION } from './passages.js';
import type { DocsLanguage, DocsPage, DocsPassagesFile } from './passages.js';

// Created when a warning is logged, not when the module loads: every route
// module that runs AI tools imports this file.
function logger(): ReturnType<typeof createLogger> {
  return createLogger('ai-docs-search');
}

/** The operationId of the docs search route (tool `docs_search`). */
export const DOCS_SEARCH_OPERATION_ID = 'docsSearch';

export const DOCS_SEARCH_DEFAULT_LIMIT = 5;
export const DOCS_SEARCH_MAX_LIMIT = 10;
export const DOCS_SEARCH_MAX_QUERY = 500;

/** The documentation website: the only host a citation links to. */
export const DOCS_ORIGIN = 'https://evtivity.com';

export interface DocsPassage {
  id: string;
  language: DocsLanguage;
  path: string;
  pageTitle: string;
  heading: string;
  anchor: string;
  text: string;
}

export function isDocsLanguage(value: unknown): value is DocsLanguage {
  return typeof value === 'string' && (DOCS_LANGUAGES as readonly string[]).includes(value);
}

const DOCS_PATH = /^\/docs(?:\/[a-z0-9][a-z0-9-]*)+$/;

/**
 * The website URL of a passage: `https://evtivity.com/<lang>/docs/...#anchor`,
 * English without a language prefix (the website serves it at `/docs/...`).
 * Null for a path that is not a docs page path.
 */
export function docsPassageUrl(
  passage: Pick<DocsPassage, 'language' | 'path' | 'anchor'>,
): string | null {
  if (!DOCS_PATH.test(passage.path) || !isDocsLanguage(passage.language)) return null;
  const prefix = passage.language === 'en' ? '' : `/${passage.language}`;
  const url = new URL(`${prefix}${passage.path}`, DOCS_ORIGIN);
  if (passage.anchor !== '') url.hash = passage.anchor;
  return url.href;
}

/** True for an https URL on the documentation website's docs pages. */
export function isDocsCitationUrl(value: string): boolean {
  const url = URL.parse(value);
  if (url == null || url.origin !== DOCS_ORIGIN) return false;
  if (url.username !== '' || url.password !== '' || url.search !== '') return false;
  const segments = url.pathname.split('/');
  const path = isDocsLanguage(segments[1]) ? `/${segments.slice(2).join('/')}` : url.pathname;
  return DOCS_PATH.test(path);
}

export function passageTitle(passage: DocsPassage): string {
  const title =
    passage.anchor === '' || passage.heading === passage.pageTitle
      ? passage.pageTitle
      : `${passage.pageTitle} - ${passage.heading}`;
  return title.slice(0, 500);
}

/** A passage as the model and the citation see it; null when it has no valid URL. */
export function toSearchResult(passage: DocsPassage): AiSearchResult | null {
  const url = docsPassageUrl(passage);
  if (url === null) return null;
  return { id: passage.id, title: passageTitle(passage), url, text: passage.text };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface DocsCorpus {
  byLanguage: ReadonlyMap<DocsLanguage, readonly DocsPassage[]>;
  byId: ReadonlyMap<string, DocsPassage>;
}

/** Numbers the passages of a passages file. Pages with an invalid path are skipped. */
export function corpusFromFile(file: DocsPassagesFile): DocsCorpus {
  const byLanguage = new Map<DocsLanguage, DocsPassage[]>();
  const byId = new Map<string, DocsPassage>();
  let next = 1;
  for (const language of DOCS_LANGUAGES) {
    const pages: DocsPage[] = file.languages[language] ?? [];
    const passages: DocsPassage[] = [];
    for (const page of pages) {
      if (!DOCS_PATH.test(page.path)) continue;
      for (const section of page.sections) {
        const passage: DocsPassage = {
          id: String(next++),
          language,
          path: page.path,
          pageTitle: page.title,
          heading: section.heading,
          anchor: section.anchor,
          text: section.text,
        };
        passages.push(passage);
        byId.set(passage.id, passage);
      }
    }
    if (passages.length > 0) byLanguage.set(language, passages);
  }
  return { byLanguage, byId };
}

function isPassagesFile(value: unknown): value is DocsPassagesFile {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Partial<DocsPassagesFile>;
  return (
    v.version === DOCS_PASSAGES_VERSION && v.languages != null && typeof v.languages === 'object'
  );
}

export function docsPassagesPath(env: NodeJS.ProcessEnv = process.env): string {
  const indexPath = env['DOCS_INDEX_PATH'] ?? resolve('docs-index.json');
  return join(dirname(indexPath), 'docs-passages.json');
}

const EMPTY: DocsCorpus = { byLanguage: new Map(), byId: new Map() };
let loaded: DocsCorpus | null = null;

/** The passages, read once on first use (an absent or unreadable file is an empty corpus). */
export function docsCorpus(): DocsCorpus {
  if (loaded !== null) return loaded;
  const path = docsPassagesPath();
  if (!existsSync(path)) {
    logger().warn({ path }, 'No docs passages file, docs_search returns nothing');
    loaded = EMPTY;
    return loaded;
  }
  const file = tryParseJson(readFileSync(path, 'utf8'));
  if (!isPassagesFile(file)) {
    logger().warn({ path }, 'Docs passages file is not version 2, docs_search returns nothing');
    loaded = EMPTY;
    return loaded;
  }
  loaded = corpusFromFile(file);
  return loaded;
}

/** Test seam: replaces the loaded corpus (null reloads from disk on next use). */
export function setDocsCorpusForTests(corpus: DocsCorpus | null): void {
  loaded = corpus;
  indexes.clear();
}

// ---------------------------------------------------------------------------
// Search (BM25 over words, character pairs for Chinese, Japanese and Korean)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it my of on or the this to what when where which who why with you your'.split(
    ' ',
  ),
);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Search tokens of a text: lower-case words, character pairs inside CJK runs. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text
    .normalize('NFKC')
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (!CJK.test(word)) {
      if (word.length < 2 || STOPWORDS.has(word)) continue;
      out.push(word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
      continue;
    }
    // Mixed runs: Latin parts as words, CJK parts as overlapping pairs.
    for (const run of word.matchAll(
      /(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
    )) {
      const part = run[0];
      if (!CJK.test(part)) {
        if (part.length >= 2 && !STOPWORDS.has(part)) out.push(part);
        continue;
      }
      const chars = Array.from(part);
      if (chars.length === 1) out.push(part);
      for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i] ?? ''}${chars[i + 1] ?? ''}`);
    }
  }
  return out;
}

interface LanguageIndex {
  passages: readonly DocsPassage[];
  terms: Map<string, number>[];
  headings: Set<string>[];
  lengths: number[];
  averageLength: number;
  documentFrequency: Map<string, number>;
}

const indexes = new Map<DocsLanguage, LanguageIndex>();

function languageIndex(corpus: DocsCorpus, language: DocsLanguage): LanguageIndex | null {
  const cached = indexes.get(language);
  if (cached !== undefined) return cached;
  const passages = corpus.byLanguage.get(language);
  if (passages === undefined || passages.length === 0) return null;
  const terms: Map<string, number>[] = [];
  const headings: Set<string>[] = [];
  const lengths: number[] = [];
  const documentFrequency = new Map<string, number>();
  for (const passage of passages) {
    const tokens = tokenize(passage.text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const heading = new Set(tokenize(`${passage.pageTitle} ${passage.heading}`));
    for (const token of new Set([...counts.keys(), ...heading])) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    terms.push(counts);
    headings.push(heading);
    lengths.push(tokens.length);
  }
  const averageLength = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
  const index = { passages, terms, headings, lengths, averageLength, documentFrequency };
  indexes.set(language, index);
  return index;
}

const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 1.5;

function rank(index: LanguageIndex, query: string[], limit: number): DocsPassage[] {
  const n = index.passages.length;
  const unique = [...new Set(query)];
  const scored: { passage: DocsPassage; score: number }[] = [];
  index.passages.forEach((passage, i) => {
    let score = 0;
    for (const term of unique) {
      const df = index.documentFrequency.get(term) ?? 0;
      if (df === 0) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      const tf = index.terms[i]?.get(term) ?? 0;
      if (tf > 0) {
        const norm = 1 - B + (B * (index.lengths[i] ?? 0)) / index.averageLength;
        score += (idf * tf * (K1 + 1)) / (tf + K1 * norm);
      }
      if (index.headings[i]?.has(term) === true) score += idf * HEADING_WEIGHT;
    }
    if (score > 0) scored.push({ passage, score });
  });
  scored.sort((a, b) => b.score - a.score || Number(a.passage.id) - Number(b.passage.id));
  return scored.slice(0, limit).map((s) => s.passage);
}

export interface DocsSearchResult {
  /** Language of the passages returned. */
  language: DocsLanguage;
  /** True when the requested language had no match and English was searched. */
  fallback: boolean;
  results: AiSearchResult[];
}

/**
 * The best passages for a query in a language, else in English. An empty
 * corpus or a query without search terms returns no results.
 */
export function searchDocs(
  query: string,
  language: DocsLanguage,
  limit = DOCS_SEARCH_DEFAULT_LIMIT,
  corpus: DocsCorpus = docsCorpus(),
): DocsSearchResult {
  const terms = tokenize(query.slice(0, DOCS_SEARCH_MAX_QUERY));
  const max = Math.min(Math.max(1, Math.trunc(limit)), DOCS_SEARCH_MAX_LIMIT);
  const run = (lang: DocsLanguage): AiSearchResult[] => {
    const index = terms.length === 0 ? null : languageIndex(corpus, lang);
    if (index === null) return [];
    return rank(index, terms, max).flatMap((p) => toSearchResult(p) ?? []);
  };
  const results = run(language);
  if (results.length > 0 || language === 'en') return { language, fallback: false, results };
  return { language: 'en', fallback: true, results: run('en') };
}

/**
 * The passages a `docs_search` result named, rebuilt from the corpus (the
 * model and the citation get server text, never the response body).
 */
export function searchResultsForIds(
  ids: readonly unknown[],
  corpus: DocsCorpus = docsCorpus(),
): AiSearchResult[] {
  const out: AiSearchResult[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const passage = corpus.byId.get(id);
    const result = passage === undefined ? null : toSearchResult(passage);
    if (result !== null) out.push(result);
  }
  return out;
}

/** The ids in a `docs_search` response body (`{ results: [{ id }] }`). */
export function docsSearchResponseIds(value: unknown): unknown[] {
  if (value == null || typeof value !== 'object') return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((r: unknown) =>
    r != null && typeof r === 'object' ? (r as { id?: unknown }).id : undefined,
  );
}
