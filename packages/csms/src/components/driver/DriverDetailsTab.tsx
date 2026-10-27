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
import { LANGUAGES, LanguageSelect } from '@/components/ui/language-select';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { TabPanel } from '@/components/ui/tab-panel';
import { TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { DriverPortalAccessCard, type PortalAccess } from './DriverPortalAccessCard';
import { DriverPncContractsCard } from './DriverPncContractsCard';
import { DriverBillingCard, type DriverBilling } from './DriverBillingCard';
import { DriverBillingAddressCard } from './DriverBillingAddressCard';
import { DriverEraseCard } from './DriverEraseCard';
import { AvatarField } from '@/components/avatar/AvatarField';
import type { AvatarData } from '@/components/AccountAvatar';
import { useToast } from '@/components/ui/toast';
import { useHasPermission } from '@/lib/auth';
import { applyAvatarChoice, driverAvatarPath, type AvatarChoice } from '@/lib/avatar';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  language: string;
  isActive: boolean;
  erasedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  portalAccess?: PortalAccess;
  billing?: DriverBilling;
  avatar?: AvatarData | null;
}

export interface DriverDetailsTabProps {
  driver: Driver;
  timezone: string;
}

export function DriverDetailsTab({ driver, timezone }: DriverDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasPermission('drivers:write');

  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [language, setLanguage] = useState('en');
  const [isActive, setIsActive] = useState(true);
  const [hasSubmittedEdit, setHasSubmittedEdit] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: {
      firstName?: string;
      lastName?: string;
      email?: string | null;
      phone?: string | null;
      language?: string;
      isActive?: boolean;
    }) => api.patch<Driver>(`/v1/drivers/${driver.id}`, body),
    onSuccess: () => {
      // The prefix also refreshes the tokens a deactivation turned off.
      void queryClient.invalidateQueries({ queryKey: ['drivers'] });
      setEditing(false);
      setHasSubmittedEdit(false);
    },
  });

  // A driver with portal access signs in with the email, so it cannot be removed.
  const emailRequired = driver.portalAccess?.status === 'active';

  function startEdit(): void {
    setFirstName(driver.firstName);
    setLastName(driver.lastName);
    setEmail(driver.email ?? '');
    setPhone(driver.phone ?? '');
    setLanguage(driver.language);
    setIsActive(driver.isActive);
    updateMutation.reset();
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
    if (emailRequired && email.trim() === '') {
      errors.email = t('validation.required');
    }
    return errors;
  }

  const editErrors = getEditValidationErrors();

  /** The avatar is stored at once, apart from the form's Save (drivers:write). */
  async function saveAvatar(choice: AvatarChoice): Promise<void> {
    await applyAvatarChoice(driverAvatarPath(driver.id), choice);
    toast({
      title: t(choice.kind === 'remove' ? 'avatar.removed' : 'avatar.saved'),
      variant: 'success',
    });
    // The driver page, the driver list and fleet member rows show it.
    void queryClient.invalidateQueries({ queryKey: ['drivers'] });
    void queryClient.invalidateQueries({ queryKey: ['fleets'] });
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmittedEdit(true);
    if (Object.keys(editErrors).length > 0) return;
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    updateMutation.mutate({
      firstName,
      lastName,
      // An emptied field removes the stored value; a field left empty sends nothing.
      ...(trimmedEmail !== ''
        ? { email: trimmedEmail }
        : driver.email != null
          ? { email: null }
          : {}),
      ...(trimmedPhone !== ''
        ? { phone: trimmedPhone }
        : driver.phone != null
          ? { phone: null }
          : {}),
      language,
      isActive,
    });
  }

  return (
    <TabsContent value="details">
      {/* An erased driver is an anonymized stub that cannot change. */}
      <TabPanel
        data-testid="driver-details-card"
        title={t('common.details')}
        actions={
          !editing && driver.erasedAt == null ? (
            <EditButton label={t('common.edit')} onClick={startEdit} />
          ) : undefined
        }
      >
        {editing ? (
          <form onSubmit={handleSave} noValidate className="space-y-4">
            <AvatarField
              avatar={driver.avatar}
              firstName={driver.firstName}
              lastName={driver.lastName}
              description={t('avatar.editDescriptionDriver')}
              {...(canWrite ? { onSave: saveAvatar } : {})}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-first" className="leading-6">
                  {t('drivers.firstName')}
                </Label>
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
                <Label htmlFor="edit-last" className="leading-6">
                  {t('drivers.lastName')}
                </Label>
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
              <Label htmlFor="edit-email" className="leading-6">
                {t('common.email')}
              </Label>
              <Input
                id="edit-email"
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
                className={hasSubmittedEdit && editErrors.email ? 'border-destructive' : ''}
              />
              {hasSubmittedEdit && editErrors.email && (
                <p className="text-sm text-destructive">{editErrors.email}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone" className="leading-6">
                {t('drivers.phone')}
              </Label>
              <Input
                id="edit-phone"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-language" className="leading-6">
                {t('drivers.language')}
              </Label>
              <LanguageSelect id="edit-language" value={language} onChange={setLanguage} />
              <p className="text-sm text-muted-foreground">{t('drivers.languageHelp')}</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="edit-active"
                  checked={isActive}
                  onChange={(e) => {
                    setIsActive(e.target.checked);
                  }}
                />
                <Label htmlFor="edit-active">{t('common.active')}</Label>
              </div>
              <p className="text-sm text-muted-foreground">{t('drivers.activeHelp')}</p>
            </div>
            {updateMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(updateMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                  setHasSubmittedEdit(false);
                }}
              />
              <SaveButton isPending={updateMutation.isPending} />
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
              <dd className="font-medium">{driver.email ?? t('common.na')}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('drivers.phone')}</dt>
              <dd className="font-medium">{driver.phone ?? t('common.na')}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('drivers.language')}</dt>
              <dd className="font-medium">
                {LANGUAGES.find((lang) => lang.code === driver.language)?.label ?? driver.language}
              </dd>
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
      </TabPanel>
      <DriverBillingCard billing={driver.billing} />
      <DriverBillingAddressCard driver={driver} />
      <DriverPortalAccessCard driver={driver} timezone={timezone} />
      <DriverPncContractsCard driverId={driver.id} timezone={timezone} />
      <DriverEraseCard driver={driver} timezone={timezone} />
    </TabsContent>
  );
}
