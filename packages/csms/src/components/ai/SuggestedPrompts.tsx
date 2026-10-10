// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import { Sparkles } from 'lucide-react';

export const SUGGESTION_PAGES = [
  'dashboard',
  'stations',
  'sessions',
  'drivers',
  'sites',
  'supportCases',
  'pricing',
  'reservations',
  'general',
] as const;
export type SuggestionPage = (typeof SUGGESTION_PAGES)[number];

const PAGE_BY_SEGMENT: Readonly<Record<string, SuggestionPage>> = {
  '': 'dashboard',
  stations: 'stations',
  sessions: 'sessions',
  drivers: 'drivers',
  sites: 'sites',
  'support-cases': 'supportCases',
  pricing: 'pricing',
  tariffs: 'pricing',
  reservations: 'reservations',
};

/** The suggestion set of a route: its first path segment, else the general set. */
export function suggestionPageFor(pathname: string): SuggestionPage {
  const segment = pathname.split('/').find((s) => s !== '') ?? '';
  return PAGE_BY_SEGMENT[segment] ?? 'general';
}

export const SUGGESTION_SLOTS = ['p1', 'p2', 'p3'] as const;

interface SuggestedPromptsProps {
  onPick: (prompt: string) => void;
  disabled: boolean;
}

/** Starter questions for the page the user is on (locale keys `ai.suggestions.<page>.p1..p3`). */
export function SuggestedPrompts({ onPick, disabled }: SuggestedPromptsProps): React.JSX.Element {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const page = suggestionPageFor(pathname);
  return (
    <div className="space-y-2" data-testid="ai-suggestions" data-page={page}>
      <p className="text-xs font-medium text-muted-foreground">{t('ai.suggestionsTitle')}</p>
      <ul className="space-y-1.5">
        {SUGGESTION_SLOTS.map((slot) => {
          const prompt = t(`ai.suggestions.${page}.${slot}`);
          return (
            <li key={slot}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  onPick(prompt);
                }}
                className="flex w-full items-start gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                <span>{prompt}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
