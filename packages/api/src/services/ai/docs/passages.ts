// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The documentation passages file (`docs-passages.json`, version 2): the
 * website docs MDX of every locale cut into sections, one per `##` or `###`
 * heading, so `docs_search` can return a passage and its anchor. Written by
 * `generate-docs-passages.ts` from a website checkout; never edited by hand.
 *
 * Anchors follow the website: `rehype-slug`, which uses GitHub's slug rules
 * (lower case, punctuation removed, spaces as `-`, a repeated heading gets
 * `-1`, `-2`), counted over every heading of the page.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const DOCS_PASSAGES_VERSION = 2;

/** Languages the website serves, in file order. */
export const DOCS_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'] as const;
export type DocsLanguage = (typeof DOCS_LANGUAGES)[number];

/** Longest section text; a longer section is split at paragraphs into parts with the same anchor. */
export const MAX_SECTION_CHARS = 1800;

export interface DocsSection {
  /** Heading id on the website page; empty for the text before the first heading. */
  anchor: string;
  heading: string;
  text: string;
}

export interface DocsPage {
  /** Website path without a language prefix, such as `/docs/csms/sessions`. */
  path: string;
  title: string;
  sections: DocsSection[];
}

export interface DocsPassagesFile {
  version: typeof DOCS_PASSAGES_VERSION;
  /** Pages per website language (`en`, `de`, `es`, `ko`, `zh`, `zh-TW`). */
  languages: Record<string, DocsPage[]>;
}

/** GitHub's slug of one heading (github-slugger), without the repeat suffix. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** Slugs for the headings of one page, in order, with `-1`, `-2` for repeats. */
export class HeadingSlugger {
  private readonly seen = new Map<string, number>();

  slug(text: string): string {
    const base = slugifyHeading(text);
    let slug = base;
    let count = this.seen.get(base) ?? 0;
    while (this.seen.has(slug)) {
      count += 1;
      slug = `${base}-${String(count)}`;
    }
    this.seen.set(base, count);
    this.seen.set(slug, 0);
    return slug;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * The text without HTML or JSX tags. Repeated until nothing changes, so a
 * nested fragment (`<scr<b>ipt>`) cannot leave a tag behind.
 */
function stripTags(text: string): string {
  let out = text;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/<\/?[A-Za-z][^>]*>/g, '');
  } while (out !== previous);
  return out;
}

/** Inline markdown of one prose line as plain text (links keep their label). */
function plainInline(line: string): string {
  const withoutTags = stripTags(
    line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\{\/\*.*?\*\/\}/g, ''),
  );
  return decodeEntities(
    withoutTags.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1'),
  );
}

/** Heading text as the website renders it (inline code without backticks). */
function headingText(raw: string): string {
  return plainInline(raw)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

function frontmatter(source: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (match === null) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const field = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (field !== null) {
      fields[field[1] ?? ''] = (field[2] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return { fields, body: source.slice(match[0].length) };
}

/** Splits a long text at paragraph breaks (then lines, then characters) into parts. */
export function splitSectionText(text: string, max = MAX_SECTION_CHARS): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = '';
  const push = (): void => {
    if (current.trim() !== '') parts.push(current.trim());
    current = '';
  };
  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length <= max ? [paragraph] : paragraph.split('\n');
    for (const piece of pieces) {
      for (let i = 0; i < piece.length; i += max) {
        const chunk = piece.slice(i, i + max);
        if (current !== '' && current.length + chunk.length + 2 > max) push();
        current = current === '' ? chunk : `${current}\n\n${chunk}`;
      }
    }
  }
  push();
  return parts;
}

/**
 * One MDX page as sections: the text before the first `##` (under the page
 * title), then one section per `##` or `###` heading. Deeper headings stay
 * in their section as a line. Code blocks are kept; images, JSX tags,
 * imports and comments are dropped; links keep their label.
 */
export function mdxToPage(path: string, source: string): DocsPage | null {
  const { fields, body } = frontmatter(source);
  const title = plainInline(fields['title'] ?? '').trim();
  if (title === '') return null;
  const slugger = new HeadingSlugger();
  const sections: DocsSection[] = [];
  let current: DocsSection = { anchor: '', heading: title, text: '' };
  const lines: string[] = [];
  const close = (): void => {
    const text = lines
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    lines.length = 0;
    if (text === '') return;
    for (const part of splitSectionText(text)) sections.push({ ...current, text: part });
  };
  let fence: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fence !== null) {
      lines.push(line);
      if (fenceMatch !== null && fenceMatch[1]?.startsWith(fence) === true) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] ?? '```';
      lines.push(line.trim());
      continue;
    }
    if (/^(import|export)\s/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const text = headingText(heading[2] ?? '');
      const anchor = slugger.slug(text);
      if (level === 2 || level === 3) {
        close();
        current = { anchor, heading: text, text: '' };
      } else {
        lines.push(text);
      }
      continue;
    }
    lines.push(plainInline(line));
  }
  close();
  return { path, title, sections };
}

/**
 * Serializes the file with one page per line, so a regenerated file diffs
 * by page.
 */
export function serializeDocsPassages(file: DocsPassagesFile): string {
  const languages = Object.entries(file.languages)
    .map(
      ([language, pages]) =>
        `${JSON.stringify(language)}:[\n${pages.map((p) => JSON.stringify(p)).join(',\n')}\n]`,
    )
    .join(',\n');
  return `{"version":${String(file.version)},"languages":{\n${languages}\n}}\n`;
}

function mdxFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...mdxFiles(full, base));
    else if (entry.endsWith('.mdx')) out.push(relative(base, full));
  }
  return out;
}

/**
 * Reads `<docsDir>/<language>/.../<page>.mdx` (the website's
 * `app/content/docs`) into the passages file. A language without a folder
 * is left out; English is required.
 */
export function buildDocsPassages(docsDir: string): DocsPassagesFile {
  const languages: Record<string, DocsPage[]> = {};
  for (const language of DOCS_LANGUAGES) {
    const dir = join(docsDir, language);
    if (!existsSync(dir)) continue;
    const pages: DocsPage[] = [];
    for (const file of mdxFiles(dir, dir)) {
      const path = `/docs/${file.replace(/\\/g, '/').replace(/\.mdx$/, '')}`;
      const page = mdxToPage(path, readFileSync(join(dir, file), 'utf8'));
      if (page !== null && page.sections.length > 0) pages.push(page);
    }
    languages[language] = pages.sort((a, b) => a.path.localeCompare(b.path));
  }
  if ((languages['en'] ?? []).length === 0) {
    throw new Error(`No English docs pages under ${join(docsDir, 'en')}`);
  }
  return { version: DOCS_PASSAGES_VERSION, languages };
}
