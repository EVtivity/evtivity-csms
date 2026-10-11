// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * DeepSeek's own tool-call markup ("DSML"). The model sometimes writes its
 * tool calls into `content` with this markup instead of `tool_calls`:
 *
 *   <｜DSML｜function_calls>
 *   <｜DSML｜invoke name="list_sites">
 *   <｜DSML｜parameter name="search" string="true">north</｜DSML｜parameter>
 *   <｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜function_calls>
 *
 * The markup must never reach the user as text. The stream mapper cuts it
 * out of the text at the first special-token marker (`<｜`, a fullwidth bar)
 * and turns the invokes it can read into tool calls.
 */

/** Every DeepSeek special token starts with this. */
export const SPECIAL_TOKEN_MARKER = '<｜';

export interface DsmlInvoke {
  name: string;
  /** JSON text of the arguments object, or the reason it could not be read. */
  arguments: string;
}

const INVOKE = /<｜DSML｜invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜DSML｜invoke>/g;
const PARAMETER =
  /<｜DSML｜parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/｜DSML｜parameter>/g;

/** The invokes of a markup block; text without any gives an empty list. */
export function parseDsmlInvokes(markup: string): DsmlInvoke[] {
  const out: DsmlInvoke[] = [];
  for (const invoke of markup.matchAll(INVOKE)) {
    const args: Record<string, unknown> = {};
    let readable = true;
    for (const param of (invoke[2] ?? '').matchAll(PARAMETER)) {
      const name = param[1] ?? '';
      const raw = param[3] ?? '';
      if (param[2] === 'false') {
        try {
          args[name] = JSON.parse(raw) as unknown;
        } catch {
          // fail-open: an unreadable value makes the call a tool_call_error below.
          readable = false;
        }
      } else {
        args[name] = raw;
      }
    }
    out.push({
      name: invoke[1] ?? '',
      arguments: readable ? JSON.stringify(args) : (invoke[2] ?? ''),
    });
  }
  return out;
}

/**
 * Splits streamed text at the first special-token marker. `held` is text
 * kept back because it could be the start of a marker split across chunks.
 */
export function splitAtMarker(text: string): {
  visible: string;
  markup: string | null;
  held: string;
} {
  const at = text.indexOf(SPECIAL_TOKEN_MARKER);
  if (at >= 0) return { visible: text.slice(0, at), markup: text.slice(at), held: '' };
  if (text.endsWith('<')) return { visible: text.slice(0, -1), markup: null, held: '<' };
  return { visible: text, markup: null, held: '' };
}
