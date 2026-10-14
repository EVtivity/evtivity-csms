// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TokenStatusBadge } from '@/components/token/TokenStatusBadge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DriverCombobox } from '@/components/driver-combobox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTimeLocal } from '@/lib/reservation-datetime';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/timezone';
import { formatCents } from '@/lib/formatting';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import { centsToMajorInput, parseMajorInputToCents } from '@evtivity/lib/currency';
import { OCPP_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';

interface TokenData {
  id: string;
  driverId: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  deactivatedBy?: 'operator' | 'driver' | 'system' | null;
  prepaidBalanceCents: number | null;
  createdAt: string;
  updatedAt: string;
  driverFirstName: string | null;
  driverLastName: string | null;
  driverEmail: string | null;
}

interface TokenDetailsTabProps {
  token: TokenData;
  timezone: string;
}

export function TokenDetailsTab({ token, timezone }: TokenDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currency } = useCompanyCurrency();
  const { toast } = useToast();

  const [editing, setEditing] = useState(false);
  const [idToken, setIdToken] = useState('');
  const [tokenType, setTokenType] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [expiresAt, setExpiresAt] = useState('');
  const [isPrepaid, setIsPrepaid] = useState(false);
  const [prepaidBalance, setPrepaidBalance] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: {
      idToken?: string;
      tokenType?: string;
      driverId?: string | null;
      isActive?: boolean;
      expiresAt?: string | null;
      prepaidBalanceCents?: number | null;
    }) => api.patch<TokenData>(`/v1/tokens/${token.id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tokens', token.id] });
      void queryClient.invalidateQueries({ queryKey: ['tokens'] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/v1/tokens/${token.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tokens'] });
      void navigate('/tokens');
    },
    onError: (err) => {
      setDeleteOpen(false);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  function startEdit(): void {
    setIdToken(token.idToken);
    setTokenType(token.tokenType);
    setIsActive(token.isActive);
    setExpiresAt(token.expiresAt != null ? formatDateTimeLocal(new Date(token.expiresAt)) : '');
    setIsPrepaid(token.prepaidBalanceCents != null);
    setPrepaidBalance(
      token.prepaidBalanceCents != null ? centsToMajorInput(token.prepaidBalanceCents) : '',
    );
    setSelectedDriver(
      token.driverId && token.driverFirstName
        ? {
            id: token.driverId,
            name: `${token.driverFirstName} ${token.driverLastName ?? ''}`.trim(),
          }
        : null,
    );
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (idToken.trim() === '') {
      errors.idToken = t('validation.required');
    }
    if (expiresAt.trim() !== '' && !Number.isFinite(new Date(expiresAt).getTime())) {
      errors.expiresAt = t('validation.invalidValue');
    }
    if (isPrepaid) {
      if (prepaidBalance.trim() === '') {
        errors.prepaidBalance = t('validation.required');
      } else if (parseMajorInputToCents(prepaidBalance) == null) {
        errors.prepaidBalance = t('validation.invalidNumber');
      }
    }
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    updateMutation.mutate({
      idToken,
      tokenType,
      driverId: selectedDriver?.id ?? null,
      isActive,
      expiresAt: expiresAt.trim() !== '' ? new Date(expiresAt).toISOString() : null,
      prepaidBalanceCents: isPrepaid ? parseMajorInputToCents(prepaidBalance) : null,
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle>{t('tokens.tokenDetails')}</CardTitle>
          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
            {!editing && (
              <>
                <EditButton label={t('common.edit')} onClick={startEdit} />
                <RemoveButton
                  label={t('common.delete')}
                  onClick={() => {
                    setDeleteOpen(true);
                  }}
                />
              </>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-idToken" className="leading-6">
                  {t('tokens.tokenValue')}
                </Label>
                <Input
                  id="edit-idToken"
                  value={idToken}
                  onChange={(e) => {
                    setIdToken(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.idToken ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.idToken && (
                  <p className="text-sm text-destructive">{validationErrors.idToken}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-tokenType" className="leading-6">
                  {t('tokens.tokenType')}
                </Label>
                <Select
                  id="edit-tokenType"
                  value={tokenType}
                  onChange={(e) => {
                    setTokenType(e.target.value);
                  }}
                >
                  {OCPP_ID_TOKEN_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="leading-6">{t('tokens.driver')}</Label>
                <DriverCombobox value={selectedDriver} onSelect={setSelectedDriver} />
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
              <div className="space-y-2">
                <Label htmlFor="edit-expiresAt" className="leading-6">
                  {t('tokens.expiresAt')}
                </Label>
                <Input
                  id="edit-expiresAt"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => {
                    setExpiresAt(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.expiresAt ? 'border-destructive' : ''}
                />
                <p className="text-sm text-muted-foreground">{t('tokens.expiresAtHint')}</p>
                {hasSubmitted && validationErrors.expiresAt && (
                  <p className="text-sm text-destructive">{validationErrors.expiresAt}</p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    id="edit-prepaid"
                    type="checkbox"
                    checked={isPrepaid}
                    onChange={(e) => {
                      setIsPrepaid(e.target.checked);
                    }}
                    className="h-4 w-4 rounded border-input"
                  />
                  <Label htmlFor="edit-prepaid">{t('tokens.prepaid')}</Label>
                </div>
                <p className="text-sm text-muted-foreground">{t('tokens.prepaidHint')}</p>
              </div>
              {isPrepaid && (
                <div className="space-y-2">
                  <Label htmlFor="edit-prepaidBalance" className="leading-6">
                    {t('tokens.prepaidBalance')}
                    {currency != null ? ` (${currency})` : ''}
                  </Label>
                  <DecimalInput
                    id="edit-prepaidBalance"
                    value={prepaidBalance}
                    onChange={setPrepaidBalance}
                    allowNegative
                    decimalScale={2}
                    className={
                      hasSubmitted && validationErrors.prepaidBalance ? 'border-destructive' : ''
                    }
                  />
                  {hasSubmitted && validationErrors.prepaidBalance && (
                    <p className="text-sm text-destructive">{validationErrors.prepaidBalance}</p>
                  )}
                </div>
              )}
              {updateMutation.isError && (
                <p className="text-sm text-destructive">
                  {getErrorMessage(updateMutation.error, t)}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
                <SaveButton isPending={updateMutation.isPending} />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('tokens.tokenValue')}</dt>
                <dd className="font-medium">{token.idToken}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('tokens.tokenType')}</dt>
                <dd className="font-medium">{token.tokenType}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('tokens.driver')}</dt>
                <dd className="font-medium">
                  {token.driverId && token.driverFirstName ? (
                    <Link to={`/drivers/${token.driverId}`} className="hover:underline">
                      {token.driverFirstName} {token.driverLastName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{t('tokens.unassigned')}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.status')}</dt>
                <dd className="font-medium">
                  <TokenStatusBadge token={token} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('tokens.expiresAt')}</dt>
                <dd className="font-medium">
                  {token.expiresAt != null ? (
                    formatDateTime(token.expiresAt, timezone)
                  ) : (
                    <span className="text-muted-foreground">{t('tokens.noExpiry')}</span>
                  )}
                </dd>
              </div>
              {!token.isActive && (
                <>
                  <div>
                    <dt className="text-muted-foreground">{t('tokens.deactivatedAt')}</dt>
                    <dd className="font-medium">
                      {token.revokedAt != null ? formatDateTime(token.revokedAt, timezone) : 'n/a'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('tokens.deactivatedBy')}</dt>
                    <dd className="font-medium">
                      {token.deactivatedBy != null
                        ? t(`tokens.deactivatedByValue.${token.deactivatedBy}`)
                        : 'n/a'}
                    </dd>
                  </div>
                  {token.revokedReason != null && token.revokedReason !== '' && (
                    <div>
                      <dt className="text-muted-foreground">{t('tokens.deactivationReason')}</dt>
                      <dd className="font-medium">{token.revokedReason}</dd>
                    </div>
                  )}
                </>
              )}
              <div>
                <dt className="text-muted-foreground">{t('tokens.prepaidBalance')}</dt>
                <dd className="font-medium">
                  {token.prepaidBalanceCents == null ? (
                    <span className="text-muted-foreground">{t('tokens.notPrepaid')}</span>
                  ) : currency != null ? (
                    formatCents(token.prepaidBalanceCents, currency)
                  ) : (
                    // Never an amount without its currency.
                    <span className="text-muted-foreground">{t('common.loading')}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(token.createdAt, timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(token.updatedAt, timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('tokens.deleteConfirm')}
        description={t('tokens.deleteConfirmDescription')}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          deleteMutation.mutate();
        }}
      />
    </>
  );
}
