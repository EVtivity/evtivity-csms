// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { getModelEntry } from '../core/model-registry.js';
import type { AiStreamEvent, ModelCapabilities } from '../core/types.js';
import {
  CITATION_MARKER_RULE,
  CitationMarkerFilter,
  CitationStream,
  promptedSearchResultsText,
  toolResultText,
} from '../providers/citations.js';
import { redactProviderRequest } from '../redact.js';

function caps(citations: ModelCapabilities['citations']): ModelCapabilities {
  const entry = getModelEntry('deepseek', 'deepseek-flash');
  if (entry === undefined) throw new Error('registry entry missing');
  return { ...entry.capabilities, citations };
}

function streamText(chunks: string[]): { text: string; ids: string[] } {
  const filter = new CitationMarkerFilter();
  let text = '';
  const ids: string[] = [];
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    text += out.text;
    ids.push(...out.ids);
  }
  return { text: text + filter.flush(), ids };
}

describe('CitationMarkerFilter (TC-AI-M-06)', () => {
  it('cuts markers and the space before them', () => {
    expect(streamText(['Open Settings [doc:3]. Save [doc:4][doc:5].'])).toEqual({
      text: 'Open Settings. Save.',
      ids: ['3', '4', '5'],
    });
  });

  it('joins a marker split across deltas', () => {
    expect(streamText(['Open [', 'do', 'c:', '12', '] now'])).toEqual({
      text: 'Open now',
      ids: ['12'],
    });
  });

  it('reads a list marker', () => {
    expect(streamText(['A [doc:1, doc:2] B [doc:3,4]'])).toEqual({
      text: 'A B',
      ids: ['1', '2', '3', '4'],
    });
  });

  it('keeps brackets that are no marker', () => {
    expect(streamText(['See [docs](https://evtivity.com/docs) and [d', 'ata] [doc:x]'])).toEqual({
      text: 'See [docs](https://evtivity.com/docs) and [data] [doc:x]',
      ids: [],
    });
  });

  it('gives back held text at the end of the stream', () => {
    expect(streamText(['Unfinished [doc:'])).toEqual({ text: 'Unfinished [doc:', ids: [] });
  });
});

describe('CitationStream', () => {
  it('turns markers into citation events for a prompted model', () => {
    const stream = new CitationStream(caps('prompted'));
    const events: AiStreamEvent[] = [
      ...stream.map([{ type: 'text_delta', text: 'Done [do' }]),
      ...stream.map([{ type: 'usage', usage: usageOf(1) }]),
      ...stream.map([{ type: 'text_delta', text: 'c:7].' }]),
      ...stream.map([{ type: 'finish', reason: 'end' }]),
    ];
    expect(events.filter((e) => e.type === 'citation')).toEqual([
      { type: 'citation', citation: { passageId: '7' } },
    ]);
    const text = events.map((e) => (e.type === 'text_delta' ? e.text : '')).join('');
    expect(text).toBe('Done.');
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'end' });
  });

  it('flushes held text before a tool call', () => {
    const stream = new CitationStream(caps('prompted'));
    const events = [
      ...stream.map([{ type: 'text_delta', text: 'Checking [d' }]),
      ...stream.map([{ type: 'tool_call_start', index: 0, id: 'c1', name: 'docs_search' }]),
    ];
    expect(events[0]).toEqual({ type: 'text_delta', text: 'Checking' });
    expect(events[1]).toEqual({ type: 'text_delta', text: ' [d' });
  });

  it('passes events through for a native model', () => {
    const stream = new CitationStream(caps('native'));
    const event: AiStreamEvent = { type: 'text_delta', text: 'Literal [doc:1]' };
    expect(stream.map([event])).toEqual([event]);
  });
});

function usageOf(n: number) {
  return {
    inputTokens: n,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: n,
    reasoningTokens: 0,
  };
}

const PASSAGE = {
  id: '7',
  title: 'Settings - Company',
  url: 'https://evtivity.com/docs/csms/settings#company',
  text: 'Open Settings. Contact admin@example.com for help.',
};

describe('prompted passages', () => {
  it('lists each passage under its marker after the rule', () => {
    const text = promptedSearchResultsText([PASSAGE]);
    expect(text.startsWith(CITATION_MARKER_RULE)).toBe(true);
    expect(text).toContain('[doc:7] Settings - Company\nOpen Settings.');
    expect(text).toContain('<untrusted source="docs_search"');
  });

  it('uses the stored content for an error or a result without passages', () => {
    const part = {
      type: 'tool_result' as const,
      toolCallId: 'c1',
      name: 'docs_search',
      content: 'stored',
      isError: false,
    };
    expect(toolResultText(part)).toBe('stored');
    expect(toolResultText({ ...part, isError: true, searchResults: [PASSAGE] })).toBe('stored');
    expect(toolResultText({ ...part, searchResults: [PASSAGE] })).toContain('[doc:7]');
  });

  it('the provider boundary redacts passage text on the support surface', () => {
    const req = redactProviderRequest(
      {
        model: 'm',
        system: [],
        tools: [],
        effort: 'low',
        messages: [
          {
            role: 'tool',
            parts: [
              {
                type: 'tool_result',
                toolCallId: 'c1',
                name: 'docs_search',
                content: '{}',
                isError: false,
                searchResults: [PASSAGE],
              },
            ],
          },
        ],
      },
      'support',
    );
    const part = req.messages[0]?.parts[0];
    expect(part?.type === 'tool_result' ? part.searchResults?.[0]?.text : '').not.toContain(
      'admin@example.com',
    );
  });
});
