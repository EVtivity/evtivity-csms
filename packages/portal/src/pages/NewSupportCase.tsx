// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PageHeader } from '@/components/PageHeader';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const sessionId = searchParams.get('sessionId') ?? undefined;
  const stationName = searchParams.get('stationName') ?? undefined;

  const [category, setCategory] = useState<string>('general_inquiry');
  const [subject, setSubject] = useState(stationName != null ? `Issue at ${stationName}` : '');
  const [description, setDescription] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.post<{ id: string }>('/v1/portal/support-cases', data),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['portal-support-cases'] });
      void navigate(`/support/${result.id}`);
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
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('supportCases.newCase')} backTo="/support" />

      <form onSubmit={handleSubmit} className="space-y-4">
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

        {createMutation.isError && (
          <p className="text-sm text-destructive">{createMutation.error.message}</p>
        )}

        <Button type="submit" className="w-full" disabled={createMutation.isPending}>
          {createMutation.isPending ? t('common.creating') : t('supportCases.submitCase')}
        </Button>
      </form>
    </div>
  );
}
