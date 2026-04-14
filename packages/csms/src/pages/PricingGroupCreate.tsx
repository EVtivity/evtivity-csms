// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import type { PricingGroup } from '@/lib/types';

export function PricingGroupCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string; isDefault?: boolean }) =>
      api.post<PricingGroup>('/v1/pricing-groups', body),
    onSuccess: (created) => {
      void navigate(`/pricing/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: { name: string; description?: string; isDefault?: boolean } = { name };
    if (description.trim() !== '') body.description = description;
    if (isDefault) body.isDefault = true;
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/pricing" />
        <h1 className="text-2xl md:text-3xl font-bold">{t('pricing.createPricingGroup')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-name">{t('common.name')}</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className={hasSubmitted && errors.name ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.name && (
                <p className="text-sm text-destructive">{errors.name}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="group-description">{t('common.description')}</Label>
              <Input
                id="group-description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="group-default"
                checked={isDefault}
                onChange={(e) => {
                  setIsDefault(e.target.checked);
                }}
              />
              <Label htmlFor="group-default">{t('common.default')}</Label>
            </div>
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/pricing');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
