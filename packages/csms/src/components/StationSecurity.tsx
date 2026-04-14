// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { SecurityProfileBadge } from '@/components/SecurityProfileBadge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface StationSecurityProps {
  stationId: string;
  stationDbId: string;
  securityProfile: number;
  hasPassword: boolean;
  isOnline: boolean;
  timezone: string;
  ocppProtocol: string | null;
}

interface SecurityLog {
  id: number;
  event: string;
  remoteAddress: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function getProfileDescLabel(
  profile: number,
  is16: boolean,
):
  | 'stations.sp0Desc'
  | 'stations.sp1Desc'
  | 'stations.sp2Desc'
  | 'stations.sp3Desc'
  | 'stations.sp16_0Desc'
  | 'stations.sp16_1Desc'
  | 'stations.sp16_2Desc' {
  if (is16) {
    if (profile === 0) return 'stations.sp16_0Desc';
    if (profile === 2) return 'stations.sp16_2Desc';
    return 'stations.sp16_1Desc';
  }
  if (profile === 0) return 'stations.sp0Desc';
  if (profile === 2) return 'stations.sp2Desc';
  if (profile === 3) return 'stations.sp3Desc';
  return 'stations.sp1Desc';
}

export function StationSecurity({
  stationId,
  stationDbId,
  securityProfile,
  hasPassword,
  isOnline,
  timezone,
  ocppProtocol,
}: StationSecurityProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordConfirmOpen, setPasswordConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingProfile, setPendingProfile] = useState<number | null>(null);
  const [profileConfirmOpen, setProfileConfirmOpen] = useState(false);
  const [profilePassword, setProfilePassword] = useState('');
  const [profilePasswordConfirm, setProfilePasswordConfirm] = useState('');
  const [logsPage, setLogsPage] = useState(1);
  const [hasSubmittedPassword, setHasSubmittedPassword] = useState(false);
  const [hasSubmittedProfilePassword, setHasSubmittedProfilePassword] = useState(false);
  const logsLimit = 20;

  const { data: logsResponse } = useQuery({
    queryKey: ['stations', stationDbId, 'security-logs', logsPage],
    queryFn: () =>
      api.get<{ data: SecurityLog[]; total: number }>(
        `/v1/stations/${stationDbId}/security-logs?page=${String(logsPage)}&limit=${String(logsLimit)}`,
      ),
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: { securityProfile: number; password?: string }) =>
      api.patch(`/v1/stations/${stationDbId}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationDbId] });
      setPendingProfile(null);
      setProfileConfirmOpen(false);
      setProfilePassword('');
      setProfilePasswordConfirm('');
      setHasSubmittedProfilePassword(false);
    },
  });

  const setPasswordMutation = useMutation({
    mutationFn: (pw: string) =>
      api.post(`/v1/stations/${stationDbId}/credentials`, { password: pw }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationDbId] });
      setPasswordConfirmOpen(false);
      setShowPasswordForm(false);
      setPassword('');
      setConfirmPassword('');
      setHasSubmittedPassword(false);
    },
  });

  function generatePassword(): string {
    const bytes = new Uint8Array(15);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).slice(0, 20);
  }

  function handleRotateCredentials(): void {
    const generated = generatePassword();
    setPassword(generated);
    setConfirmPassword(generated);
    setShowPasswordForm(true);
  }

  function handleProfileSelect(newProfile: number): void {
    if (newProfile === securityProfile) {
      resetPendingProfile();
      return;
    }
    setShowPasswordForm(false);
    setPendingProfile(newProfile);
  }

  function handleProfileConfirm(): void {
    if (pendingProfile == null) return;
    const data: { securityProfile: number; password?: string } = {
      securityProfile: pendingProfile,
    };
    if (profilePassword.length >= 8) {
      data.password = profilePassword;
    }
    updateProfileMutation.mutate(data);
  }

  function handleProfileSave(): void {
    if (isOnline) {
      setProfileConfirmOpen(true);
    } else {
      handleProfileConfirm();
    }
  }

  function resetPendingProfile(): void {
    setPendingProfile(null);
    setProfileConfirmOpen(false);
    setProfilePassword('');
    setProfilePasswordConfirm('');
    setHasSubmittedProfilePassword(false);
  }

  function resetPasswordForm(): void {
    setShowPasswordForm(false);
    setPassword('');
    setConfirmPassword('');
    setHasSubmittedPassword(false);
  }

  function getPasswordErrors(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (password.trim() === '') {
      errs.password = t('validation.required');
    } else if (password.length < 8) {
      errs.password = t('validation.minLength', { min: 8 });
    }
    if (confirmPassword.trim() === '') {
      errs.confirmPassword = t('validation.required');
    } else if (password !== confirmPassword) {
      errs.confirmPassword = t('validation.passwordMismatch');
    }
    return errs;
  }

  function getProfilePasswordErrors(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (profilePassword.trim() === '') {
      errs.profilePassword = t('validation.required');
    } else if (profilePassword.length < 8) {
      errs.profilePassword = t('validation.minLength', { min: 8 });
    }
    if (profilePasswordConfirm.trim() === '') {
      errs.profilePasswordConfirm = t('validation.required');
    } else if (profilePassword !== profilePasswordConfirm) {
      errs.profilePasswordConfirm = t('validation.passwordMismatch');
    }
    return errs;
  }

  const passwordErrors = getPasswordErrors();
  const profilePasswordErrors = getProfilePasswordErrors();

  const is16 = ocppProtocol === 'ocpp1.6';
  const needsPassword =
    pendingProfile != null && pendingProfile >= 1 && pendingProfile < 3 && !hasPassword;
  const showProfileConfirm = pendingProfile != null && !needsPassword;

  const logsTotalPages = Math.max(1, Math.ceil((logsResponse?.total ?? 0) / logsLimit));

  return (
    <div className="space-y-6">
      {/* Security Profile & Credentials */}
      <Card>
        <CardHeader>
          <CardTitle>{t('stations.securityProfile')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <SecurityProfileBadge profile={securityProfile} ocppProtocol={ocppProtocol} />
            <span className="text-sm text-muted-foreground">
              {t(getProfileDescLabel(securityProfile, is16))}
            </span>
          </div>

          {is16 ? (
            <>
              <p className="text-sm text-muted-foreground">{t('stations.security16Info')}</p>

              <div className="border-t pt-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm">{t('stations.passwordStatus')}</span>
                  <Badge variant={hasPassword ? 'default' : 'outline'}>
                    {hasPassword ? t('stations.passwordSet') : t('stations.passwordNotSet')}
                  </Badge>
                </div>
              </div>

              {!showPasswordForm && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPassword('');
                    setConfirmPassword('');
                    setShowPasswordForm(true);
                  }}
                >
                  {hasPassword ? t('stations.changePassword') : t('stations.setPassword')}
                </Button>
              )}

              {showPasswordForm && (
                <div className="rounded-md border p-4 space-y-3">
                  <p className="text-sm font-medium">
                    {hasPassword ? t('stations.changePassword') : t('stations.setPassword')}
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="new-password">{t('stations.newPassword')}</Label>
                    <PasswordInput
                      id="new-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                      }}
                      placeholder={t('stations.passwordPlaceholder')}
                      className={
                        hasSubmittedPassword && passwordErrors.password ? 'border-destructive' : ''
                      }
                    />
                    {hasSubmittedPassword && passwordErrors.password && (
                      <p className="text-sm text-destructive">{passwordErrors.password}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">{t('stations.confirmPassword')}</Label>
                    <PasswordInput
                      id="confirm-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                      }}
                      className={
                        hasSubmittedPassword && passwordErrors.confirmPassword
                          ? 'border-destructive'
                          : ''
                      }
                    />
                    {hasSubmittedPassword && passwordErrors.confirmPassword && (
                      <p className="text-sm text-destructive">{passwordErrors.confirmPassword}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <SaveButton
                      isPending={setPasswordMutation.isPending}
                      type="button"
                      onClick={() => {
                        setHasSubmittedPassword(true);
                        if (Object.keys(passwordErrors).length > 0) return;
                        setPasswordMutation.mutate(password);
                      }}
                      label={hasPassword ? t('stations.changePassword') : t('stations.setPassword')}
                    />
                    <CancelButton onClick={resetPasswordForm} />
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Label htmlFor="security-profile" className="text-sm whitespace-nowrap">
                  {t('stations.changeProfile')}:
                </Label>
                <Select
                  id="security-profile"
                  value={String(pendingProfile ?? securityProfile)}
                  onChange={(e) => {
                    handleProfileSelect(Number(e.target.value));
                  }}
                  className="h-9"
                  disabled={updateProfileMutation.isPending}
                >
                  <option value="0">{t('stations.sp0')}</option>
                  <option value="1">{t('stations.sp1')}</option>
                  <option value="2">{t('stations.sp2')}</option>
                  <option value="3">{t('stations.sp3')}</option>
                </Select>
                {securityProfile >= 1 && securityProfile < 3 && pendingProfile == null && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (!showPasswordForm) {
                          setPassword('');
                          setConfirmPassword('');
                        }
                        setShowPasswordForm(!showPasswordForm);
                      }}
                    >
                      {t('stations.changePassword')}
                    </Button>
                    {hasPassword && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (showPasswordForm) {
                            resetPasswordForm();
                          } else {
                            handleRotateCredentials();
                          }
                        }}
                      >
                        <RotateCcw className="h-4 w-4" />
                        {t('stations.rotateCredentials')}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {securityProfile >= 1 && securityProfile < 3 && pendingProfile == null && (
                <p className="text-xs text-muted-foreground">{t('stations.rotateHelpText')}</p>
              )}
              {securityProfile === 3 && pendingProfile == null && (
                <p className="text-xs text-muted-foreground">{t('stations.sp3CertNote')}</p>
              )}

              {/* Inline password form when upgrading to SP1/SP2 without a password */}
              {needsPassword && (
                <div className="rounded-md border p-4 space-y-3">
                  <p className="text-sm font-medium">{t('stations.passwordRequiredForProfile')}</p>
                  <div className="space-y-2">
                    <Label htmlFor="profile-password">{t('stations.password')}</Label>
                    <PasswordInput
                      id="profile-password"
                      value={profilePassword}
                      onChange={(e) => {
                        setProfilePassword(e.target.value);
                      }}
                      placeholder={t('stations.passwordPlaceholder')}
                      className={
                        hasSubmittedProfilePassword && profilePasswordErrors.profilePassword
                          ? 'border-destructive'
                          : ''
                      }
                    />
                    {hasSubmittedProfilePassword && profilePasswordErrors.profilePassword && (
                      <p className="text-sm text-destructive">
                        {profilePasswordErrors.profilePassword}
                      </p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-password-confirm">
                      {t('stations.confirmPassword')}
                    </Label>
                    <PasswordInput
                      id="profile-password-confirm"
                      value={profilePasswordConfirm}
                      onChange={(e) => {
                        setProfilePasswordConfirm(e.target.value);
                      }}
                      className={
                        hasSubmittedProfilePassword && profilePasswordErrors.profilePasswordConfirm
                          ? 'border-destructive'
                          : ''
                      }
                    />
                    {hasSubmittedProfilePassword &&
                      profilePasswordErrors.profilePasswordConfirm && (
                        <p className="text-sm text-destructive">
                          {profilePasswordErrors.profilePasswordConfirm}
                        </p>
                      )}
                  </div>
                  {!isOnline && (
                    <p className="text-xs text-destructive">
                      {t('stations.profileChangeOcppOffline')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <SaveButton
                      isPending={updateProfileMutation.isPending}
                      type="button"
                      onClick={() => {
                        setHasSubmittedProfilePassword(true);
                        if (Object.keys(profilePasswordErrors).length > 0) return;
                        handleProfileSave();
                      }}
                      label={t('stations.savePassword')}
                    />
                    <CancelButton onClick={resetPendingProfile} />
                  </div>
                </div>
              )}

              {/* Inline profile change confirm */}
              {showProfileConfirm && (
                <div className="rounded-md border p-4 space-y-3">
                  <p className="text-sm font-medium">{t('stations.changeProfile')}</p>
                  {!isOnline && (
                    <p className="text-xs text-destructive">
                      {t('stations.profileChangeOcppOffline')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <SaveButton
                      isPending={updateProfileMutation.isPending}
                      type="button"
                      onClick={handleProfileSave}
                    />
                    <CancelButton onClick={resetPendingProfile} />
                  </div>
                </div>
              )}

              {/* Inline change password form */}
              {showPasswordForm && !needsPassword && (
                <div className="rounded-md border p-4 space-y-3">
                  <p className="text-sm font-medium">{t('stations.changePassword')}</p>
                  <div className="space-y-2">
                    <Label htmlFor="new-password">{t('stations.newPassword')}</Label>
                    <PasswordInput
                      id="new-password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                      }}
                      placeholder={t('stations.passwordPlaceholder')}
                      className={
                        hasSubmittedPassword && passwordErrors.password ? 'border-destructive' : ''
                      }
                    />
                    {hasSubmittedPassword && passwordErrors.password && (
                      <p className="text-sm text-destructive">{passwordErrors.password}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">{t('stations.confirmPassword')}</Label>
                    <PasswordInput
                      id="confirm-password"
                      value={confirmPassword}
                      onChange={(e) => {
                        setConfirmPassword(e.target.value);
                      }}
                      className={
                        hasSubmittedPassword && passwordErrors.confirmPassword
                          ? 'border-destructive'
                          : ''
                      }
                    />
                    {hasSubmittedPassword && passwordErrors.confirmPassword && (
                      <p className="text-sm text-destructive">{passwordErrors.confirmPassword}</p>
                    )}
                  </div>
                  {!isOnline && (
                    <p className="text-xs text-destructive">
                      {t('stations.changePasswordOcppOffline')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <SaveButton
                      isPending={setPasswordMutation.isPending}
                      type="button"
                      onClick={() => {
                        setHasSubmittedPassword(true);
                        if (Object.keys(passwordErrors).length > 0) return;
                        if (isOnline) {
                          setPasswordConfirmOpen(true);
                        } else {
                          setPasswordMutation.mutate(password);
                        }
                      }}
                      label={t('stations.changePassword')}
                    />
                    <CancelButton onClick={resetPasswordForm} />
                  </div>
                </div>
              )}

              <div className="border-t pt-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm">{t('stations.passwordStatus')}</span>
                  <Badge variant={hasPassword ? 'default' : 'outline'}>
                    {hasPassword ? t('stations.passwordSet') : t('stations.passwordNotSet')}
                  </Badge>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Security Event Log */}
      <Card>
        <CardHeader>
          <CardTitle>{t('stations.securityLog')}</CardTitle>
        </CardHeader>
        <CardContent>
          {logsResponse != null && logsResponse.data.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-2 pr-4">{t('common.timestamp')}</th>
                      <th className="pb-2 pr-4">{t('stations.eventType')}</th>
                      <th className="pb-2 pr-4">{t('stations.remoteAddress')}</th>
                      <th className="pb-2">{t('common.details')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logsResponse.data.map((log) => (
                      <tr key={log.id} className="border-b">
                        <td className="py-2 pr-4 text-muted-foreground whitespace-nowrap">
                          {formatDateTime(log.createdAt, timezone)}
                        </td>
                        <td className="py-2 pr-4">
                          <Badge variant="outline">{log.event}</Badge>
                        </td>
                        <td className="py-2 pr-4 text-xs">{log.remoteAddress ?? '-'}</td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {log.metadata != null ? JSON.stringify(log.metadata) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4">
                <Pagination
                  page={logsPage}
                  totalPages={logsTotalPages}
                  onPageChange={setLogsPage}
                />
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('stations.noSecurityLogs')}</p>
          )}
        </CardContent>
      </Card>

      {/* Profile Change Confirm Dialog (online) */}
      <ConfirmDialog
        open={profileConfirmOpen}
        onOpenChange={(open) => {
          if (!open) resetPendingProfile();
        }}
        title={t('stations.changeProfile')}
        description={t('stations.profileChangeOcppOnline', { stationId })}
        confirmLabel={t('stations.changeProfile')}
        onConfirm={handleProfileConfirm}
      />

      {/* Change Password Confirm Dialog */}
      <ConfirmDialog
        open={passwordConfirmOpen}
        onOpenChange={setPasswordConfirmOpen}
        title={t('stations.changePassword')}
        description={t('stations.changePasswordConfirm', { stationId })}
        confirmLabel={t('stations.changePassword')}
        onConfirm={() => {
          setPasswordMutation.mutate(password);
        }}
      />
    </div>
  );
}
