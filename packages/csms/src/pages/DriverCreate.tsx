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
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

export function DriverCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: { firstName: string; lastName: string; email?: string; phone?: string }) =>
      api.post<Driver>('/v1/drivers', body),
    onSuccess: (created) => {
      void navigate(`/drivers/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!firstName.trim()) errors.firstName = t('validation.required');
    if (!lastName.trim()) errors.lastName = t('validation.required');
    if (!email.trim()) errors.email = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: { firstName: string; lastName: string; email?: string; phone?: string } = {
      firstName,
      lastName,
    };
    if (email.trim() !== '') body.email = email;
    if (phone.trim() !== '') body.phone = phone;
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/drivers" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('drivers.createDriver')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="driver-firstName">{t('drivers.firstName')}</Label>
                <Input
                  id="driver-firstName"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                  className={hasSubmitted && errors.firstName ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.firstName && (
                  <p className="text-sm text-destructive">{errors.firstName}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="driver-lastName">{t('drivers.lastName')}</Label>
                <Input
                  id="driver-lastName"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                  className={hasSubmitted && errors.lastName ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.lastName && (
                  <p className="text-sm text-destructive">{errors.lastName}</p>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver-email">{t('common.email')}</Label>
              <Input
                id="driver-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmitted && errors.email ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="driver-phone">{t('drivers.phone')}</Label>
              <Input
                id="driver-phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
              />
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/drivers');
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
