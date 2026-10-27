// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Buttons the 375 px layout sweep found cut off or overflowing on full data: two fixed button
// columns, the station OCPP command tiles, the Use This Vehicle button in the session card and
// the automatic insight button (its pulse and count sat inside it).

import { describe, expect, it } from 'vitest';
import commands from '../StationCommands.tsx?raw';
import useVehicleButton from '../use-vehicle-button.tsx?raw';
import recordInsight from '../ai/insights/RecordInsight.tsx?raw';
import generatedReports from '../reports/GeneratedReportsTab.tsx?raw';

const SOURCES = import.meta.glob<string>(['../../**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const TWO_FIXED_COLUMNS = 'grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2';
const WRAPPING_ROW = 'flex flex-wrap gap-2 *:grow sm:*:grow-0';

// Rows that hold a field and its icon button, or cards, not text buttons.
const NOT_BUTTON_ROWS = new Set([
  '../config-template/TemplateVariableRows.tsx',
  '../settings/ApiKeysSettings.tsx',
  '../settings/SecuritySsoSettings.tsx',
  '../layout/SiteLayout.tsx',
  '../user/UserSecurityTab.tsx',
]);

describe('Phone-width buttons', () => {
  it('wraps rows of text buttons instead of two fixed columns that cut long labels off', () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path, source]) => source.includes(TWO_FIXED_COLUMNS) && !NOT_BUTTON_ROWS.has(path))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('stacks the Generated Reports actions in their table cell on phones', () => {
    expect(generatedReports).toContain(`<div className="${WRAPPING_ROW}">`);
  });

  it('lets the OCPP command tiles and Use This Vehicle wrap their labels', () => {
    expect(commands).toMatch(/key=\{action\}\s+variant="outline"\s+size="wrap"/);
    expect(useVehicleButton).toContain('<Button size="wrap"');
  });

  it('keeps the insight pulse and count outside the floating button', () => {
    const button = recordInsight.slice(
      recordInsight.indexOf('<Button'),
      recordInsight.indexOf('</Button>'),
    );
    expect(button).not.toContain('record-insight-pulse');
    expect(button).not.toContain('{live.length}');
    expect(recordInsight).toContain('<div className="fixed bottom-24 right-6 z-40 flex">');
  });
});
