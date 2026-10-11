// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
import type {
  DriverAiConsentRecord,
  DriverAiState,
  SupportCaseResolutionSource,
} from '@evtivity/lib/driver-ai';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/timezone';

/** The driver AI fields of the operator case detail (`GET /v1/support-cases/:id`). */
export interface SupportCaseAiFields {
  aiConsent?: DriverAiConsentRecord | null;
  aiState?: DriverAiState | null;
  aiStateReason?: string | null;
  aiAnsweredAt?: string | null;
  aiFeedbackAt?: string | null;
  resolutionSource?: SupportCaseResolutionSource | null;
}

/** Badge variant of a driver AI state. */
export function driverAiStateVariant(
  state: DriverAiState,
): 'secondary' | 'success' | 'warning' | 'info' | 'outline' {
  switch (state) {
    case 'queued':
    case 'analyzing':
    case 'awaiting_feedback':
      return 'info';
    case 'resolved_by_ai':
      return 'success';
    case 'failed':
      return 'warning';
    case 'escalated':
      return 'secondary';
    default:
      return 'outline';
  }
}

/**
 * Badge of a case the automatic answer handled: the AI state, or "Resolved
 * by AI" once the driver said the answer solved the issue.
 */
export function SupportCaseAiBadge({
  aiState,
  resolutionSource,
}: Pick<SupportCaseAiFields, 'aiState' | 'resolutionSource'>): React.JSX.Element | null {
  const { t } = useTranslation();
  if (resolutionSource === 'ai') {
    return (
      <Badge variant="success" className="gap-1">
        <Bot className="h-3 w-3" aria-hidden="true" />
        {t('supportCases.ai.resolvedByAi')}
      </Badge>
    );
  }
  if (aiState == null) return null;
  return (
    <Badge variant={driverAiStateVariant(aiState)} className="gap-1">
      <Bot className="h-3 w-3" aria-hidden="true" />
      {t(`supportCases.ai.state.${aiState}`, aiState)}
    </Badge>
  );
}

/**
 * The driver consent and the AI step of a case (plan v0.1.45, 2.12): the
 * decision with its server time, notice language and version, then the AI
 * state, its reason and the answer and feedback times. Hidden when the
 * driver was not asked and the case had no AI step.
 */
export function SupportCaseAiCard({
  fields,
  timezone,
}: {
  fields: SupportCaseAiFields;
  timezone: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const consent = fields.aiConsent ?? null;
  const state = fields.aiState ?? null;
  if (consent == null && state == null) return null;

  return (
    <Card data-testid="support-case-ai-card">
      <CardHeader>
        <CardTitle>{t('supportCases.ai.consentTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <Field label={t('supportCases.ai.consentDecision')}>
          {consent != null
            ? t(`supportCases.ai.consent.${consent.decision}`)
            : t('supportCases.ai.consent.notAsked')}
        </Field>
        {consent != null && (
          <>
            <Field label={t('supportCases.ai.consentAt')}>
              {formatDateTime(consent.at, timezone)}
            </Field>
            <Field label={t('supportCases.ai.consentLanguage')}>{consent.language}</Field>
            <Field label={t('supportCases.ai.noticeVersion')}>
              {String(consent.noticeVersion)}
            </Field>
          </>
        )}
        {state != null && (
          <Field label={t('supportCases.ai.stateLabel')}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={driverAiStateVariant(state)}>
                {t(`supportCases.ai.state.${state}`, state)}
              </Badge>
              {fields.aiStateReason != null && (
                <span className="text-muted-foreground">
                  {t(`supportCases.ai.reason.${fields.aiStateReason}`, fields.aiStateReason)}
                </span>
              )}
            </div>
          </Field>
        )}
        {fields.aiAnsweredAt != null && (
          <Field label={t('supportCases.ai.answeredAt')}>
            {formatDateTime(fields.aiAnsweredAt, timezone)}
          </Field>
        )}
        {fields.aiFeedbackAt != null && (
          <Field label={t('supportCases.ai.feedbackAt')}>
            {formatDateTime(fields.aiFeedbackAt, timezone)}
          </Field>
        )}
        {fields.resolutionSource != null && (
          <Field label={t('supportCases.ai.filterResolvedBy')}>
            {t(`supportCases.ai.resolutionSource.${fields.resolutionSource}`)}
          </Field>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}
