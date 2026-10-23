// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { SaveButton } from '@/components/save-button';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { SimDetailData } from './sim-detail';

const LABEL_MAX = 100;
const NOTES_MAX = 2000;

/** The label, notes and IMSI of a SIM (`PATCH /v1/sims/:id`); the ICCID never changes. */
export function SimEditForm({ sim }: { sim: SimDetailData }): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const loaded = { label: sim.label ?? '', notes: sim.notes ?? '', imsi: sim.imsi ?? '' };
  // A reload replaces the values only while the form is clean.
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
  });
  // The save trims every value, so a value that differs only by spaces is unchanged.
  const dirty =
    form.label.trim() !== loaded.label ||
    form.notes.trim() !== loaded.notes ||
    form.imsi.trim() !== loaded.imsi;

  const save = useMutation({
    mutationFn: (body: { label: string | null; notes: string | null; imsi: string | null }) =>
      api.patch(`/v1/sims/${sim.id}`, body),
    onSuccess: (_reply, body) => {
      // Show what was stored (trimmed), so the form is clean again.
      setForm({ label: body.label ?? '', notes: body.notes ?? '', imsi: body.imsi ?? '' });
      void queryClient.invalidateQueries({ queryKey: ['sims'] });
    },
  });

  const errors: Partial<Record<keyof typeof form, string>> = {};
  if (form.label.trim().length > LABEL_MAX) {
    errors.label = t('validation.maxLength', { max: LABEL_MAX });
  }
  if (form.notes.length > NOTES_MAX) {
    errors.notes = t('validation.maxLength', { max: NOTES_MAX });
  }
  if (form.imsi.trim() !== '' && !/^\d{1,15}$/.test(form.imsi.trim())) {
    errors.imsi = t('sims.detail.imsiInvalid');
  }

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    save.mutate({ label: orNull(form.label), notes: orNull(form.notes), imsi: orNull(form.imsi) });
  }

  const fieldClass = (field: keyof typeof form): string =>
    hasSubmitted && errors[field] != null ? 'border-destructive' : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sims.detail.editTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="sim-label">{t('sims.detail.label')}</Label>
            <Input
              id="sim-label"
              value={form.label}
              onChange={(e) => {
                update({ label: e.target.value });
              }}
              className={fieldClass('label')}
            />
            {hasSubmitted && errors.label != null ? (
              <p className="text-sm text-destructive">{errors.label}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('sims.detail.labelHint', { max: LABEL_MAX })}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sim-imsi">{t('sims.detail.imsi')}</Label>
            <Input
              id="sim-imsi"
              inputMode="numeric"
              value={form.imsi}
              onChange={(e) => {
                update({ imsi: e.target.value });
              }}
              className={fieldClass('imsi')}
            />
            {hasSubmitted && errors.imsi != null ? (
              <p className="text-sm text-destructive">{errors.imsi}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('sims.detail.imsiHint')}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="sim-notes">{t('sims.detail.notes')}</Label>
            <Textarea
              id="sim-notes"
              value={form.notes}
              onChange={(e) => {
                update({ notes: e.target.value });
              }}
              className={fieldClass('notes')}
            />
            {hasSubmitted && errors.notes != null ? (
              <p className="text-sm text-destructive">{errors.notes}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('sims.detail.notesHint', { max: NOTES_MAX })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {dirty && (
              <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>
            )}
            {save.isSuccess && !dirty && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
            <SaveButton isPending={save.isPending} disabled={save.isPending || !dirty} />
          </div>
          {save.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(save.error, t, 'sims.detail.saveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
