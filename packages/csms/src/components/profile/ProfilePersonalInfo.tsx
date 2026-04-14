// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EditButton } from '@/components/edit-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, TIMEZONE_OPTIONS } from '@/lib/timezone';
import type { UserMe } from '@/pages/Profile';

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Espanol' },
  { value: 'zh', label: '中文' },
] as const;

interface ProfilePersonalInfoProps {
  user: UserMe;
}

export function ProfilePersonalInfo({ user }: ProfilePersonalInfoProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const hydrate = useAuth((s) => s.hydrate);
  const setLanguage = useAuth((s) => s.setLanguage);
  const setTimezone = useAuth((s) => s.setTimezone);

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [editLanguage, setEditLanguage] = useState('en');
  const [editTimezone, setEditTimezone] = useState('America/New_York');

  const updateMutation = useMutation({
    mutationFn: (body: {
      firstName?: string;
      lastName?: string;
      phone?: string | null;
      language?: string;
      timezone?: string;
    }) => api.patch(`/v1/users/${user.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'me'] });
      setEditing(false);
      hydrate();
    },
  });

  function startEdit(): void {
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setEditLanguage(user.language);
    setEditTimezone(user.timezone);
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    updateMutation.mutate(
      {
        firstName,
        lastName,
        phone: phone.trim() || null,
        language: editLanguage,
        timezone: editTimezone,
      },
      {
        onSuccess: () => {
          if (editLanguage !== user.language) {
            void setLanguage(editLanguage);
          }
          if (editTimezone !== user.timezone) {
            void setTimezone(editTimezone);
          }
        },
      },
    );
  }

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('profile.personalInfo')}</CardTitle>
        {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-firstName">{t('users.firstName')}</Label>
                <Input
                  id="edit-firstName"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-lastName">{t('users.lastName')}</Label>
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
              <Label htmlFor="edit-phone">{t('users.phone')}</Label>
              <Input
                id="edit-phone"
                type="tel"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
                placeholder={t('users.phonePlaceholder')}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-language">{t('profile.language')}</Label>
                <select
                  id="edit-language"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editLanguage}
                  onChange={(e) => {
                    setEditLanguage(e.target.value);
                  }}
                >
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-timezone">{t('profile.timezone')}</Label>
                <select
                  id="edit-timezone"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
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
                </select>
              </div>
            </div>
            <div className="flex gap-2">
              <SaveButton isPending={updateMutation.isPending} />
              <CancelButton
                onClick={() => {
                  setEditing(false);
                }}
              />
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
                {LANGUAGE_OPTIONS.find((o) => o.value === user.language)?.label ?? user.language}
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
