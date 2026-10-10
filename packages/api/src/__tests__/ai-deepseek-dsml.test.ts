// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { withContractContext } from '../services/ai/__contract__/harness.js';
import { STATION_TOOL } from '../services/ai/__contract__/cases.js';
import { deepseekTarget } from '../services/ai/__contract__/targets/deepseek.js';
import { parseDsmlInvokes, splitAtMarker } from '../services/ai/providers/deepseek/dsml.js';

describe('DeepSeek tool-call markup in content (DSML)', () => {
  it('turns the markup into a tool call and never streams it as text', async () => {
    await withContractContext(deepseekTarget, ['dsml_tool_call'], {}, async (ctx) => {
      const run = await ctx.run(
        ctx.request({
          tools: [STATION_TOOL],
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'Status of CS-001?' }] }],
        }),
      );
      expect(run.error).toBeNull();
      const text = run.events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : [])).join('');
      expect(text).toBe('Checking the station. ');
      expect(text).not.toContain('DSML');
      expect(run.result.finishReason).toBe('tool_use');
      expect(run.result.toolCalls).toEqual([
        {
          type: 'tool_call',
          id: 'dsml_0',
          name: 'get_station_status',
          arguments: { stationId: 'CS-001' },
        },
      ]);
    });
  });

  it('reads string and JSON parameters, and reports an unreadable value as an error', () => {
    const markup =
      '<｜DSML｜function_calls><｜DSML｜invoke name="list_sites">' +
      '<｜DSML｜parameter name="search" string="true">north</｜DSML｜parameter>' +
      '<｜DSML｜parameter name="limit" string="false">5</｜DSML｜parameter>' +
      '</｜DSML｜invoke><｜DSML｜invoke name="get_site">' +
      '<｜DSML｜parameter name="id" string="false">{oops</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜function_calls>';
    const invokes = parseDsmlInvokes(markup);
    expect(invokes[0]).toEqual({ name: 'list_sites', arguments: '{"search":"north","limit":5}' });
    expect(invokes[1]?.name).toBe('get_site');
    expect(() => JSON.parse(invokes[1]?.arguments ?? '') as unknown).toThrow();
  });

  it('holds back a trailing "<" that may start a marker', () => {
    expect(splitAtMarker('Hello <')).toEqual({ visible: 'Hello ', markup: null, held: '<' });
    expect(splitAtMarker('a <｜DSML｜x')).toEqual({
      visible: 'a ',
      markup: '<｜DSML｜x',
      held: '',
    });
    expect(splitAtMarker('a < b')).toEqual({ visible: 'a < b', markup: null, held: '' });
  });
});
