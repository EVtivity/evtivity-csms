// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import en from './report-labels/en.json' with { type: 'json' };
import de from './report-labels/de.json' with { type: 'json' };
import es from './report-labels/es.json' with { type: 'json' };
import ko from './report-labels/ko.json' with { type: 'json' };
import zh from './report-labels/zh.json' with { type: 'json' };
import zhTW from './report-labels/zh-TW.json' with { type: 'json' };
import { isUiLanguage, type UiLanguage } from './languages.js';

/**
 * Labels of report files (CSV, XLSX, PDF) in the six UI languages: titles,
 * sheet names, column headers and summary lines. The text lives in the JSON
 * locale files next to this module. `locale` is the BCP 47 locale for numbers
 * and dates. Browser-safe, so the CSMS can read the same files.
 */
export type ReportLabels = typeof en;

const REPORT_LABELS: Record<UiLanguage, ReportLabels> = {
  en,
  de,
  es,
  ko,
  zh,
  'zh-TW': zhTW,
};

/** Labels for a language; any value that is not a UI language gets English. */
export function getReportLabels(language: string | null | undefined): ReportLabels {
  return isUiLanguage(language) ? REPORT_LABELS[language] : REPORT_LABELS.en;
}

/** Replaces each `{name}` in a label with its value. */
export function fillReportLabel(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
