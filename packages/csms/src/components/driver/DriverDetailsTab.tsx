// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DriverDetailsTabProps {
  driver: Driver;
  timezone: string;
}

export function DriverDetailsTab({ driver, timezone }: DriverDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [hasSubmittedEdit, setHasSubmittedEdit] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      isActive?: boolean;
    }) => api.patch<Driver>(`/v1/drivers/${driver.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', driver.id] });
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      setEditing(false);
      setHasSubmittedEdit(false);
    },
  });

  function startEdit(): void {
    setFirstName(driver.firstName);
    setLastName(driver.lastName);
    setEmail(driver.email ?? '');
    setPhone(driver.phone ?? '');
    setIsActive(driver.isActive);
    setEditing(true);
  }

  function getEditValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (firstName.trim() === '') {
      errors.firstName = t('validation.required');
    }
    if (lastName.trim() === '') {
      errors.lastName = t('validation.required');
    }
    return errors;
  }

  const editErrors = getEditValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedEdit(true);
    if (Object.keys(editErrors).length > 0) return;
    updateMutation.mutate({
      firstName,
      lastName,
      ...(email !== '' ? { email } : {}),
      ...(phone !== '' ? { phone } : {}),
      isActive,
    });
  }

  return (
    <TabsContent value="details" className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-first">{t('drivers.firstName')}</Label>
                  <Input
                    id="edit-first"
                    value={firstName}
                    onChange={(e) => {
                      setFirstName(e.target.value);
                    }}
                    className={hasSubmittedEdit && editErrors.firstName ? 'border-destructive' : ''}
                  />
                  {hasSubmittedEdit && editErrors.firstName && (
                    <p className="text-sm text-destructive">{editErrors.firstName}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-last">{t('drivers.lastName')}</Label>
                  <Input
                    id="edit-last"
                    value={lastName}
                    onChange={(e) => {
                      setLastName(e.target.value);
                    }}
                    className={hasSubmittedEdit && editErrors.lastName ? 'border-destructive' : ''}
                  />
                  {hasSubmittedEdit && editErrors.lastName && (
                    <p className="text-sm text-destructive">{editErrors.lastName}</p>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-email">{t('common.email')}</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-phone">{t('drivers.phone')}</Label>
                <Input
                  id="edit-phone"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="edit-active"
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => {
                    setIsActive(e.target.checked);
                  }}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="edit-active">{t('common.active')}</Label>
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmittedEdit(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('drivers.firstName')}</dt>
                <dd className="font-medium">{driver.firstName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('drivers.lastName')}</dt>
                <dd className="font-medium">{driver.lastName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.email')}</dt>
                <dd className="font-medium">{driver.email ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('drivers.phone')}</dt>
                <dd className="font-medium">{driver.phone ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.status')}</dt>
                <dd className="font-medium">
                  <Badge variant={driver.isActive ? 'default' : 'outline'}>
                    {driver.isActive ? t('common.active') : t('common.inactive')}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(driver.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(driver.updatedAt, timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
