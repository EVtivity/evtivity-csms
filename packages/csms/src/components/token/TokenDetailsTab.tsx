// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DriverCombobox } from '@/components/driver-combobox';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

const TOKEN_TYPES = [
  'DirectPayment',
  'eMAID',
  'EVCCID',
  'ISO14443',
  'ISO15693',
  'KeyCode',
  'MacAddress',
  'VIN',
] as const;

interface TokenData {
  id: string;
  driverId: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
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

  const [editing, setEditing] = useState(false);
  const [idToken, setIdToken] = useState('');
  const [tokenType, setTokenType] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [selectedDriver, setSelectedDriver] = useState<{ id: string; name: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: {
      idToken?: string;
      tokenType?: string;
      driverId?: string | null;
      isActive?: boolean;
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
  });

  function startEdit(): void {
    setIdToken(token.idToken);
    setTokenType(token.tokenType);
    setIsActive(token.isActive);
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
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('tokens.tokenDetails')}</CardTitle>
          <div className="flex gap-2">
            {!editing && (
              <>
                <EditButton label={t('common.edit')} onClick={startEdit} />
                <RemoveButton
                  label={t('tokens.deleteToken')}
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
                <Label htmlFor="edit-idToken">{t('tokens.tokenValue')}</Label>
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
                <Label htmlFor="edit-tokenType">{t('tokens.tokenType')}</Label>
                <Select
                  id="edit-tokenType"
                  value={tokenType}
                  onChange={(e) => {
                    setTokenType(e.target.value);
                  }}
                >
                  {TOKEN_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('tokens.driver')}</Label>
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
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
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
                  <Badge variant={token.isActive ? 'default' : 'outline'}>
                    {token.isActive ? t('common.active') : t('common.inactive')}
                  </Badge>
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
