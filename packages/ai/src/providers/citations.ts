// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Citations for models flagged `citations: 'prompted'` (every adapter
 * shares this; no provider SDK here). Documentation passages go to the model
 * as text, each with a `[doc:<id>]` marker, and the model is told to write
 * the marker after the sentence that uses the passage. On the way back the
 * markers are cut out of the text deltas and turned into `citation` events,
 * so a marker never reaches the client or the stored answer. The engine
 * validates every cited id against the passages of the turn.
 *
 * A model flagged `native` gets the passages as the provider's own search
 * results instead (the adapter's request mapping), and this stream filter
 * passes its events through.
 */

import type {
  AiSearchResult,
  AiStreamEvent,
  AiToolResultPart,
  ModelCapabilities,
} from '../core/types.js';
import { frameUntrusted } from '../prompt.js';

/** The instruction a prompted model gets with the passages. */
export const CITATION_MARKER_RULE =
  'Documentation passages follow. When your answer uses a passage, write its marker, such as [doc:12], right after the sentence that uses it. Use only the markers listed here, never a URL for them.';

export function citationMarker(id: string): string {
  return `[doc:${id}]`;
}

/** The passages as text for a prompted model: the rule, then each passage under its marker. */
export function promptedSearchResultsText(results: readonly AiSearchResult[]): string {
  const passages = results.map((r) => `${citationMarker(r.id)} ${r.title}\n${r.text}`).join('\n\n');
  return `${CITATION_MARKER_RULE}\n${frameUntrusted('docs_search', 'passages', passages)}`;
}

/** The text of a tool result for an adapter without native search results. */
export function toolResultText(part: AiToolResultPart): string {
  return part.searchResults !== undefined && part.searchResults.length > 0 && !part.isError
    ? promptedSearchResultsText(part.searchResults)
    : part.content;
}

/** `[doc:12]`, `[doc:3, doc:4]`, `[doc:3,4]`, with the space before it. */
const MARKER = /[ \t]?\[doc:\s*(\d{1,9})((?:\s*,\s*(?:doc:)?\s*\d{1,9})*)\]/gi;
/** A text end that may be the start of a marker still streaming. */
const PARTIAL = /[ \t]?\[(?:d(?:o(?:c(?::[\sdoc:,0-9]*)?)?)?)?$/i;
const PARTIAL_MAX = 80;

/**
 * Cuts `[doc:N]` markers out of streamed text. Text that may be the start
 * of a marker is held back until the next delta decides it.
 */
export class CitationMarkerFilter {
  private held = '';

  /** Returns the text to show and the passage ids cited in it, in order. */
  push(delta: string): { text: string; ids: string[] } {
    let text = this.held + delta;
    this.held = '';
    const partial = PARTIAL.exec(text);
    if (partial !== null && text.length - partial.index <= PARTIAL_MAX) {
      this.held = text.slice(partial.index);
      text = text.slice(0, partial.index);
    }
    const ids: string[] = [];
    const out = text.replace(MARKER, (_match, first: string, rest: string) => {
      ids.push(first);
      for (const m of rest.matchAll(/\d{1,9}/g)) ids.push(m[0]);
      return '';
    });
    return { text: out, ids };
  }

  /** Held text at the end of the stream: it was no marker. */
  flush(): string {
    const text = this.held;
    this.held = '';
    return text;
  }
}

/**
 * The stream filter of an adapter: for a prompted model it turns markers
 * into `citation` events; for a native one it passes events through.
 */
export class CitationStream {
  private readonly filter: CitationMarkerFilter | null;

  constructor(caps: ModelCapabilities) {
    this.filter = caps.citations === 'prompted' ? new CitationMarkerFilter() : null;
  }

  map(events: Iterable<AiStreamEvent>): AiStreamEvent[] {
    const out: AiStreamEvent[] = [];
    for (const event of events) {
      if (this.filter === null) {
        out.push(event);
        continue;
      }
      if (event.type === 'text_delta') {
        const { text, ids } = this.filter.push(event.text);
        if (text !== '') out.push({ type: 'text_delta', text });
        for (const id of ids) out.push({ type: 'citation', citation: { passageId: id } });
        continue;
      }
      // Usage can arrive between text chunks (Gemini sends it with each one).
      if (event.type === 'usage' || event.type === 'citation') {
        out.push(event);
        continue;
      }
      // A tool call or the finish ends the text run: held text was no marker.
      const held = this.filter.flush();
      if (held !== '') out.push({ type: 'text_delta', text: held });
      out.push(event);
    }
    return out;
  }
}
