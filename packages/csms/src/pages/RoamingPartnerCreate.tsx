// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Partner {
  id: string;
  name: string;
  countryCode: string;
  partyId: string;
}

interface CreateResult {
  partner: Partner;
  registrationToken: string;
}

export function RoamingPartnerCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [partyId, setPartyId] = useState('');
  const [versionUrl, setVersionUrl] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      countryCode: string;
      partyId: string;
      versionUrl?: string;
    }) => api.post<CreateResult>('/v1/ocpi/partners', data),
    onSuccess: (result) => {
      setCreatedToken(result.registrationToken);
      setCreatedId(result.partner.id);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    if (countryCode.length !== 2) errors.countryCode = t('roaming.partners.countryCodeLength');
    if (!partyId.trim()) errors.partyId = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const data: { name: string; countryCode: string; partyId: string; versionUrl?: string } = {
      name,
      countryCode: countryCode.toUpperCase(),
      partyId: partyId.toUpperCase(),
    };
    if (versionUrl.trim() !== '') {
      data.versionUrl = versionUrl;
    }
    createMutation.mutate(data);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/roaming/partners" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('roaming.partners.createPartner')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          {createdToken != null ? (
            <div className="space-y-4">
              <p className="text-sm">{t('roaming.partners.tokenCreated')}</p>
              <div className="rounded bg-muted p-3 text-xs break-all select-all">
                {createdToken}
              </div>
              <p className="text-xs text-muted-foreground">{t('roaming.partners.tokenWarning')}</p>
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    void navigate(`/roaming/partners/${createdId ?? ''}`);
                  }}
                >
                  {t('common.done')}
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="partner-name">{t('common.name')}</Label>
                <Input
                  id="partner-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  placeholder="Partner Name"
                  className={hasSubmitted && errors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.name && (
                  <p className="text-xs text-destructive">{errors.name}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="partner-country">{t('roaming.partners.countryCode')}</Label>
                  <Input
                    id="partner-country"
                    value={countryCode}
                    onChange={(e) => {
                      setCountryCode(e.target.value.slice(0, 2).toUpperCase());
                    }}
                    placeholder="US"
                    maxLength={2}
                    className={hasSubmitted && errors.countryCode ? 'border-destructive' : ''}
                  />
                  {hasSubmitted && errors.countryCode && (
                    <p className="text-xs text-destructive">{errors.countryCode}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="partner-party">{t('roaming.partners.partyIdLabel')}</Label>
                  <Input
                    id="partner-party"
                    value={partyId}
                    onChange={(e) => {
                      setPartyId(e.target.value.slice(0, 3).toUpperCase());
                    }}
                    placeholder="ABC"
                    maxLength={3}
                    className={hasSubmitted && errors.partyId ? 'border-destructive' : ''}
                  />
                  {hasSubmitted && errors.partyId && (
                    <p className="text-xs text-destructive">{errors.partyId}</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="partner-version-url">{t('roaming.partners.versionsUrl')}</Label>
                <Input
                  id="partner-version-url"
                  value={versionUrl}
                  onChange={(e) => {
                    setVersionUrl(e.target.value);
                  }}
                  placeholder="https://partner.example.com/ocpi/versions"
                />
              </div>
              {createMutation.isError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(createMutation.error, t)}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <CancelButton
                  onClick={() => {
                    void navigate('/roaming/partners');
                  }}
                />
                <CreateButton
                  label={t('common.create')}
                  type="submit"
                  disabled={createMutation.isPending}
                />
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
