// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Themes (Default, Soft, High Contrast) reach every page only when the page
// reads the design tokens (`bg-card`, `text-success`, `hsl(var(--border))`).
// This scans the CSMS and portal source and fails on a new hardcoded color: a
// hex color, an rgb()/hsl() literal, or a raw Tailwind palette class
// (`text-green-600`, `bg-white`). A file may keep at most the count listed
// below, each with the reason a token does not fit; an entry whose file no
// longer holds any is stale and fails too, so the list only shrinks.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../..');
const FRONTEND_SRC = ['csms/src', 'portal/src'];

const COLOR =
  /(?<=[\s'"`(:,=[{])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?)\(\s*[0-9.]|\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow|decoration|placeholder|accent|caret)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3})\b/g;

const PAYMENT_IFRAME = 'payment provider iframe styles take literal colors, not CSS variables';
const SCENE =
  '3D site layout materials (WebGL) take literal colors; outdoor scene colors do not follow a UI theme';
const CHART = 'ApexCharts takes hex colors (centralized in chart-theme)';
const STATUS = 'station and connector status palette shared with the charts and the 3D layout';
const SCRIM = 'a black scrim over the page or a photo, the same in every theme';
const EMAIL = 'email HTML and its preview render on white like the sent email';
const BRAND = 'the company brand color default (company.themeColor), not a UI token';

/** Path (relative to packages/) to the most hits it may hold, with the reason. */
const ALLOWED: Record<string, { max: number; reason: string }> = {
  'csms/src/index.css': { max: 11, reason: `print styles and the ${EMAIL}` },
  'portal/src/index.css': { max: 3, reason: 'print styles (paper is white)' },
  'csms/src/payments/adyen/config.ts': { max: 8, reason: PAYMENT_IFRAME },
  'csms/src/payments/stripe/load.ts': { max: 4, reason: PAYMENT_IFRAME },
  'portal/src/payments/adyen/config.ts': { max: 8, reason: PAYMENT_IFRAME },
  'portal/src/payments/stripe/load.ts': { max: 4, reason: PAYMENT_IFRAME },
  'csms/src/components/AuthBranding.tsx': { max: 1, reason: BRAND },
  'portal/src/components/AuthBranding.tsx': { max: 1, reason: BRAND },
  'csms/src/components/settings/CompanySettings.tsx': { max: 2, reason: BRAND },
  'csms/src/components/FilterBar.tsx': { max: 1, reason: SCRIM },
  'portal/src/components/NotificationDrawer.tsx': { max: 1, reason: SCRIM },
  'portal/src/components/ImageCarousel.tsx': {
    max: 12,
    reason: `${SCRIM}: the photo lightbox and its white controls`,
  },
  'csms/src/components/TemplateEditPanel.tsx': { max: 1, reason: EMAIL },
  'csms/src/components/notifications/EmailLogTab.tsx': { max: 1, reason: EMAIL },
  'csms/src/components/settings/NotificationSettings.tsx': { max: 11, reason: EMAIL },
  'csms/src/components/settings/PdfBrandingSettings.tsx': {
    max: 1,
    reason: 'the PDF logo preview sits on white like the printed invoice',
  },
  'csms/src/components/layout/SiteLayout3D.tsx': {
    max: 3,
    reason: 'the overhead badges are an opaque white disc in every theme (site layout standards)',
  },
  'csms/src/components/layout/StationStateIcon.tsx': {
    max: 1,
    reason: 'the overhead badge white disc (site layout standards)',
  },
  'csms/src/components/layout/site-layout-cable.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-colors.ts': { max: 90, reason: SCENE },
  'csms/src/components/layout/site-layout-model-evse-plate.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-model-unit-plate.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-model-rfid-pad.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-cables.ts': { max: 1, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-evse-plates.ts': { max: 1, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-ground.ts': { max: 12, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-rebuild.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-screen-text.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-signs.ts': { max: 3, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-solar.ts': { max: 1, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-station-model.ts': { max: 1, reason: SCENE },
  'csms/src/components/layout/site-layout-scene-templates.ts': { max: 2, reason: SCENE },
  'csms/src/components/layout/site-layout-scene.ts': { max: 4, reason: SCENE },
  'csms/src/components/charts/PaymentBreakdownChart.tsx': { max: 1, reason: CHART },
  'csms/src/components/charts/PeakUsageChart.tsx': { max: 2, reason: CHART },
  'csms/src/components/charts/StationStatusChart.tsx': { max: 1, reason: CHART },
  'csms/src/lib/chart-theme.ts': { max: 77, reason: CHART },
  'portal/src/lib/chart-theme.ts': { max: 3, reason: CHART },
  'csms/src/lib/station-display-state.ts': {
    max: 2,
    reason: 'turns a status token into a hex color for the 3D scene, with a gray fallback',
  },
  'csms/src/lib/status-variants.ts': { max: 30, reason: STATUS },
  'portal/src/lib/connector-status.ts': { max: 21, reason: STATUS },
};

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|css)$/.test(entry.name) &&
      !/\.test\./.test(entry.name) &&
      entry.name !== 'themes.css'
    ) {
      files.push(full);
    }
  }
  return files;
}

function colorCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const src of FRONTEND_SRC) {
    for (const file of sourceFiles(path.join(PACKAGES_DIR, src))) {
      const hits = readFileSync(file, 'utf8').match(COLOR)?.length ?? 0;
      if (hits > 0) counts.set(path.relative(PACKAGES_DIR, file).split(path.sep).join('/'), hits);
    }
  }
  return counts;
}

describe('hardcoded colors in the CSMS and the portal', () => {
  const counts = colorCounts();

  it('uses theme tokens instead of hardcoded colors outside the allowlist', () => {
    const over = [...counts]
      .filter(([file, hits]) => hits > (ALLOWED[file]?.max ?? 0))
      .map(
        ([file, hits]) => `${file}: ${String(hits)} (allowed ${String(ALLOWED[file]?.max ?? 0)})`,
      );
    expect(over, 'use a design token (bg-card, text-success, hsl(var(--border)))').toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    const stale = Object.keys(ALLOWED).filter((file) => !counts.has(file));
    expect(stale).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(entry.reason, file).toMatch(/\w{3}/);
    }
  });
});
