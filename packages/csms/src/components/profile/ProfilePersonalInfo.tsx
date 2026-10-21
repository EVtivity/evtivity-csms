// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, TIMEZONE_OPTIONS } from '@/lib/timezone';
import { LANGUAGES, LanguageSelect } from '@/components/ui/language-select';
import type { UserMe } from '@/pages/Profile';
import { proofRejection, type ProofRejection } from '@/components/FactorProofField';
import { getErrorMessage } from '@/lib/error-message';
import { useMfaStatus } from './mfa-status';
import {
  PhoneChangeProof,
  phoneChangeNeedsProof,
  type PhoneChangeExtras,
} from './PhoneChangeProof';

/** A phone number as the API compares it: trimmed, empty is none. */
function comparablePhone(phone: string | null | undefined): string | null {
  const trimmed = (phone ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface ProfilePersonalInfoProps {
  user: UserMe;
}

export function ProfilePersonalInfo({ user }: ProfilePersonalInfoProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const hydrate = useAuth((s) => s.hydrate);
  const applyLanguageLocal = useAuth((s) => s.applyLanguageLocal);
  const applyTimezoneLocal = useAuth((s) => s.applyTimezoneLocal);

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [editLanguage, setEditLanguage] = useState('en');
  const [editTimezone, setEditTimezone] = useState('America/New_York');
  const [phoneExtras, setPhoneExtras] = useState<PhoneChangeExtras | null>(null);
  const [phoneRejection, setPhoneRejection] = useState<ProofRejection | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const { data: mfaStatus } = useMfaStatus();
  const onPhoneExtras = useCallback((extras: PhoneChangeExtras | null) => {
    setPhoneExtras(extras);
  }, []);

  // SMS codes go to this number: changing it on an account with a factor needs a confirmation.
  const phoneChanged = comparablePhone(phone) !== comparablePhone(user.phone);
  const phoneNeedsProof = editing && phoneChanged && phoneChangeNeedsProof(mfaStatus);

  const updateMutation = useMutation({
    mutationFn: (
      body: {
        firstName?: string;
        lastName?: string;
        phone?: string | null;
        language?: string;
        timezone?: string;
      } & PhoneChangeExtras,
    ) => api.patch('/v1/users/me', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'me'] });
      setEditing(false);
      hydrate();
    },
    onError: (err: unknown, body) => {
      // Each proof works once: the confirmation asks for what the failure used up.
      if (body.proof != null || body.phoneVerification != null) {
        setPhoneRejection(proofRejection(err));
      }
    },
  });

  function startEdit(): void {
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setEditLanguage(user.language);
    setEditTimezone(user.timezone);
    setPhoneExtras(null);
    setPhoneRejection(null);
    setHasSubmitted(false);
    updateMutation.reset();
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (phoneNeedsProof && phoneExtras == null) return;
    updateMutation.mutate(
      {
        firstName,
        lastName,
        phone: phone.trim() || null,
        language: editLanguage,
        timezone: editTimezone,
        ...(phoneNeedsProof && phoneExtras != null ? phoneExtras : {}),
      },
      {
        onSuccess: () => {
          if (editLanguage !== user.language) {
            void applyLanguageLocal(editLanguage);
          }
          if (editTimezone !== user.timezone) {
            applyTimezoneLocal(editTimezone);
          }
        },
      },
    );
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('profile.personalInfo')}</CardTitle>
        {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-firstName" className="leading-6">
                  {t('users.firstName')}
                </Label>
                <Input
                  id="edit-firstName"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-lastName" className="leading-6">
                  {t('users.lastName')}
                </Label>
                <Input
                  id="edit-lastName"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone" className="leading-6">
                {t('users.phone')}
              </Label>
              <Input
                id="edit-phone"
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
                placeholder={t('users.phonePlaceholder')}
              />
              {phoneNeedsProof && mfaStatus != null && (
                <PhoneChangeProof
                  phone={phone}
                  status={mfaStatus}
                  onChange={onPhoneExtras}
                  rejection={phoneRejection}
                  showMissing={hasSubmitted}
                />
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-language" className="leading-6">
                  {t('profile.language')}
                </Label>
                <LanguageSelect
                  id="edit-language"
                  value={editLanguage}
                  onChange={setEditLanguage}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-timezone" className="leading-6">
                  {t('profile.timezone')}
                </Label>
                <Select
                  id="edit-timezone"
                  value={editTimezone}
                  onChange={(e) => {
                    setEditTimezone(e.target.value);
                  }}
                >
                  {TIMEZONE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive" role="alert">
                {getErrorMessage(updateMutation.error, t, 'profile.profileUpdateFailed')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                }}
              />
              <SaveButton isPending={updateMutation.isPending} />
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('common.name')}</dt>
              <dd className="font-medium">{displayName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.email')}</dt>
              <dd className="font-medium">{user.email}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.phone')}</dt>
              <dd className="font-medium">{user.phone ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.role')}</dt>
              <dd>
                <Badge variant="outline">{user.role?.name ?? '-'}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.status')}</dt>
              <dd>
                <Badge variant={user.isActive ? 'default' : 'secondary'}>
                  {user.isActive ? t('common.active') : t('common.inactive')}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('profile.language')}</dt>
              <dd className="font-medium">
                {LANGUAGES.find((o) => o.code === user.language)?.label ?? user.language}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('profile.timezone')}</dt>
              <dd className="font-medium">
                {TIMEZONE_OPTIONS.find((o) => o.value === user.timezone)?.label ?? user.timezone}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('users.lastLogin')}</dt>
              <dd className="font-medium">
                {user.lastLoginAt != null ? formatDateTime(user.lastLoginAt, LOCAL_TZ) : '-'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.created')}</dt>
              <dd className="font-medium">{formatDateTime(user.createdAt, LOCAL_TZ)}</dd>
            </div>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}
