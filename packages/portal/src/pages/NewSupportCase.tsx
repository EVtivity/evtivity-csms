// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PageHeader } from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { ApiError } from '@/lib/api';
import { LoadingLogo } from '@/components/loading-logo';
import type { DriverAiConsentDecision } from '@evtivity/lib/driver-ai';
import { AiConsentStep } from '@/components/support/AiConsentStep';
import { consentLanguage, useDriverAiFeature } from '@/components/support/driver-ai';

const CATEGORY_OPTIONS = [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
] as const;

export function NewSupportCase(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const sessionId = searchParams.get('sessionId') ?? undefined;
  const stationId = searchParams.get('stationId') ?? undefined;
  const stationName = searchParams.get('stationName') ?? undefined;

  const [category, setCategory] = useState<string>('general_inquiry');
  const [subject, setSubject] = useState(stationName != null ? `Issue at ${stationName}` : '');
  const [description, setDescription] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // The AI consent choice of this request, with the notice version the driver
  // saw: none until the driver presses one.
  const [aiChoice, setAiChoice] = useState<{
    decision: DriverAiConsentDecision;
    noticeVersion: number;
  } | null>(null);
  const aiDecision = aiChoice?.decision ?? null;
  const driverAi = useDriverAiFeature();

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post<{ id: string }>('/v1/portal/support-cases', data),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['portal-support-cases'] });
      void navigate(`/support/${result.id}`);
    },
    onError: (err: unknown) => {
      // A newer notice: reload the features and ask again with its text.
      const code =
        err instanceof ApiError ? (err.body as { code?: unknown } | null)?.code : undefined;
      if (code === 'DRIVER_AI_NOTICE_OUTDATED') {
        setAiChoice(null);
        void queryClient.invalidateQueries({ queryKey: ['portal-features'] });
      }
    },
  });

  function getErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (subject.trim() === '') errors.subject = t('validation.required');
    if (description.trim() === '') errors.description = t('validation.required');
    return errors;
  }

  const errors = getErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = { category, subject, description };
    if (sessionId != null) body.sessionId = sessionId;
    else if (stationId != null) body.stationId = stationId;
    if (driverAi.available && aiChoice != null) {
      body.aiConsent = {
        decision: aiChoice.decision,
        noticeVersion: aiChoice.noticeVersion,
        language: consentLanguage(i18n.resolvedLanguage ?? i18n.language),
      };
    }
    createMutation.mutate(body);
  }

  // Consent comes first: the form waits until the features are known.
  if (driverAi.isLoading) {
    return <LoadingLogo />;
  }

  const noticeVersion = driverAi.noticeVersion;
  if (driverAi.available && noticeVersion != null && aiChoice == null) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('supportCases.newCase')} backTo="/support" />
        <AiConsentStep
          noticeVersion={noticeVersion}
          onChoose={(decision) => {
            setAiChoice({ decision, noticeVersion });
          }}
        />
      </div>
    );
  }
  const choiceText =
    aiDecision === 'granted' ? t('supportCases.ai.choiceAi') : t('supportCases.ai.choiceTeam');

  return (
    <div className="space-y-4">
      <PageHeader title={t('supportCases.newCase')} backTo="/support" />

      <form onSubmit={handleSubmit} className="space-y-4">
        {driverAi.available && aiDecision != null && (
          <div className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
            <div className="min-w-0">
              <span className="text-muted-foreground">{t('supportCases.ai.yourChoice')}: </span>
              <span className="font-medium">{choiceText}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${t('supportCases.ai.changeChoice')}: ${choiceText}`}
              onClick={() => {
                setAiChoice(null);
              }}
            >
              {t('supportCases.ai.changeChoice')}
            </Button>
          </div>
        )}

        <div>
          <label htmlFor="portal-case-category" className="text-sm font-medium">
            {t('supportCases.selectCategory')}
          </label>
          <Select
            id="portal-case-category"
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
            }}
            className="mt-1"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {t(`supportCases.categories.${c}`)}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label htmlFor="portal-case-subject" className="text-sm font-medium">
            {t('supportCases.subject')}
          </label>
          <Input
            id="portal-case-subject"
            // After the AI choice the step unmounts: keep focus in the form.
            autoFocus={aiChoice != null}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
            }}
            className={`mt-1 ${hasSubmitted && errors.subject ? 'border-destructive' : ''}`}
          />
          {hasSubmitted && errors.subject && (
            <p className="text-sm text-destructive mt-1">{errors.subject}</p>
          )}
        </div>

        <div>
          <label htmlFor="portal-case-description" className="text-sm font-medium">
            {t('supportCases.description')}
          </label>
          <textarea
            id="portal-case-description"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            rows={5}
            className={`mt-1 flex w-full rounded-md border bg-background px-3 py-2 text-sm ${
              hasSubmitted && errors.description ? 'border-destructive' : 'border-input'
            }`}
          />
          {hasSubmitted && errors.description && (
            <p className="text-sm text-destructive mt-1">{errors.description}</p>
          )}
        </div>

        {sessionId != null && (
          <p className="text-xs text-muted-foreground">
            {t('supportCases.linkedSession')}: {sessionId}
          </p>
        )}

        {sessionId == null && stationId != null && (
          <p className="text-xs text-muted-foreground">
            {t('supportCases.linkedStation')}: {stationName ?? stationId}
          </p>
        )}

        {createMutation.isError && (
          <p className="text-sm text-destructive">
            {getErrorMessage(createMutation.error, t, 'supportCases.createFailed')}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={createMutation.isPending}>
          {createMutation.isPending ? t('common.creating') : t('supportCases.submitCase')}
        </Button>
      </form>
    </div>
  );
}
