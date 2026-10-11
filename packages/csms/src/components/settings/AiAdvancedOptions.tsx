// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/collapsible';

interface AiAdvancedOptionsProps {
  /** One line shown next to the title, so the closed state still says what is set. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  'data-testid'?: string;
  children: React.ReactNode;
}

/**
 * Settings > AI: rarely used options (base URLs, prompt overrides, MCP
 * origins) behind one closed disclosure (`frontend/ui.md`, "Clean,
 * user-friendly settings and forms").
 */
export function AiAdvancedOptions({
  summary,
  defaultOpen = false,
  'data-testid': testId,
  children,
}: AiAdvancedOptionsProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Collapsible
      title={t('settings.aiAdvancedOptions')}
      summary={summary}
      defaultOpen={defaultOpen}
      {...(testId != null ? { 'data-testid': testId } : {})}
    >
      {children}
    </Collapsible>
  );
}

/** The closed-state summary of a system prompt: built-in or custom. */
export function AiPromptSummary({ custom }: { custom: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return <>{custom ? t('settings.aiPromptCustomSummary') : t('settings.aiPromptDefaultSummary')}</>;
}
