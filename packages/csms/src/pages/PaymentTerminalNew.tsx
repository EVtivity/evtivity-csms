// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { LoadingLogo } from '@/components/loading-logo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { PairingFields, type PairingValue } from '@/components/payment-terminals/PairingFields';
import {
  PAYMENT_TERMINALS_KEY,
  terminalProviderName,
  usePaymentTerminalFeature,
  type PaymentTerminal,
} from '@/components/payment-terminals/payment-terminal-types';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

interface ProviderDevice {
  providerDeviceId: string;
  vendor: string | null;
  serialNumber: string | null;
  model: string | null;
  online: boolean | null;
  registered: boolean;
}

interface SiteOption {
  id: string;
  name: string;
}

const DEVICE_ID = /^[\x21-\x7e]{1,128}$/;

/**
 * Registers a cloud payment terminal by its provider device ID. Users with
 * access to every site pick the device from the provider account; others type
 * the device ID. The terminal can be paired to a station right away
 * (`stations:write`), else it belongs to a site.
 */
export function PaymentTerminalNew(): React.JSX.Element {
  const { feature, isLoading } = usePaymentTerminalFeature();
  if (isLoading) return <LoadingLogo />;
  const providers = feature?.providers ?? [];
  return <PaymentTerminalNewForm providers={providers} />;
}

function PaymentTerminalNewForm({ providers }: { providers: string[] }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const allSites = useHasAllSiteAccess();
  const canPair = useHasPermission('stations:write');

  const [provider, setProvider] = useState(providers[0] ?? '');
  const [deviceId, setDeviceId] = useState('');
  const [label, setLabel] = useState('');
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [pairing, setPairing] = useState<PairingValue>({
    stationId: canPair ? (searchParams.get('stationId') ?? '') : '',
    evseId: '',
  });
  const [siteId, setSiteId] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const devices = useQuery({
    queryKey: [...PAYMENT_TERMINALS_KEY, 'provider-devices', provider],
    queryFn: () =>
      api.get<{ devices: ProviderDevice[] }>(
        `/v1/payment-terminals/provider-devices?provider=${encodeURIComponent(provider)}`,
      ),
    enabled: allSites && provider !== '',
    retry: false,
  });
  const freeDevices = (devices.data?.devices ?? []).filter((d) => !d.registered);

  const { data: sites } = useQuery({
    queryKey: ['sites', 'filter-options'],
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<PaymentTerminal>('/v1/payment-terminals', body),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
      void navigate(`/payment-terminals/${created.id}`);
    },
  });

  const paired = pairing.stationId !== '';

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (provider === '') errors.provider = t('validation.selectRequired');
    if (deviceId.trim() === '') errors.deviceId = t('validation.required');
    else if (!DEVICE_ID.test(deviceId.trim()))
      errors.deviceId = t('paymentTerminals.new.deviceIdInvalid');
    if (label.trim().length > 100) errors.label = t('validation.maxLength', { max: 100 });
    // A site-restricted user names one of their sites for an unpaired terminal.
    if (!paired && !allSites && siteId === '') errors.siteId = t('validation.selectRequired');
    return errors;
  }
  const errors = getValidationErrors();
  const shown = hasSubmitted ? errors : {};

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = { provider, providerDeviceId: deviceId.trim() };
    if (label.trim() !== '') body.label = label.trim();
    if (vendor.trim() !== '') body.vendor = vendor.trim();
    if (model.trim() !== '') body.model = model.trim();
    if (serialNumber.trim() !== '') body.serialNumber = serialNumber.trim();
    if (paired) {
      body.stationId = pairing.stationId;
      body.evseId = pairing.evseId === '' ? null : pairing.evseId;
    } else if (siteId !== '') {
      body.siteId = siteId;
    }
    create.mutate(body);
  }

  function pickDevice(id: string): void {
    setDeviceId(id);
    const device = freeDevices.find((d) => d.providerDeviceId === id);
    if (device != null) {
      setVendor(device.vendor ?? '');
      setModel(device.model ?? '');
      setSerialNumber(device.serialNumber ?? '');
    }
    create.reset();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/payment-terminals" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('paymentTerminals.new.title')}</h1>
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('paymentTerminals.new.deviceTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="terminal-provider" className="leading-6">
                {t('paymentTerminals.new.provider')}
              </Label>
              <Select
                id="terminal-provider"
                value={provider}
                className={shown.provider != null ? 'border-destructive' : ''}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setDeviceId('');
                  create.reset();
                }}
              >
                {providers.length === 0 && (
                  <option value="">{t('paymentTerminals.new.noProvider')}</option>
                )}
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {terminalProviderName(t, p)}
                  </option>
                ))}
              </Select>
              {shown.provider != null && (
                <p className="text-sm text-destructive">{shown.provider}</p>
              )}
              {providers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('paymentTerminals.new.noProviderHint')}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="terminal-device" className="leading-6">
                {t('paymentTerminals.new.device')}
              </Label>
              {allSites ? (
                <Select
                  id="terminal-device"
                  value={deviceId}
                  className={shown.deviceId != null ? 'border-destructive' : ''}
                  onChange={(e) => {
                    pickDevice(e.target.value);
                  }}
                >
                  <option value="">
                    {devices.isLoading
                      ? t('paymentTerminals.new.loadingDevices')
                      : t('paymentTerminals.new.selectDevice')}
                  </option>
                  {freeDevices.map((d) => (
                    <option key={d.providerDeviceId} value={d.providerDeviceId}>
                      {[d.providerDeviceId, d.model, d.serialNumber]
                        .filter((v) => v != null)
                        .join(' · ')}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  id="terminal-device"
                  value={deviceId}
                  autoComplete="off"
                  className={shown.deviceId != null ? 'border-destructive' : ''}
                  onChange={(e) => {
                    setDeviceId(e.target.value);
                    create.reset();
                  }}
                />
              )}
              {shown.deviceId != null && (
                <p className="text-sm text-destructive">{shown.deviceId}</p>
              )}
              {devices.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(devices.error, t)}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {allSites
                  ? t('paymentTerminals.new.deviceHintPicker')
                  : t('paymentTerminals.new.deviceHintTyped')}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="terminal-label" className="leading-6">
                  {t('paymentTerminals.fields.label')}
                </Label>
                <Input
                  id="terminal-label"
                  value={label}
                  className={shown.label != null ? 'border-destructive' : ''}
                  onChange={(e) => {
                    setLabel(e.target.value);
                  }}
                />
                {shown.label != null && <p className="text-sm text-destructive">{shown.label}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="terminal-vendor" className="leading-6">
                  {t('paymentTerminals.fields.vendor')}
                </Label>
                <Input
                  id="terminal-vendor"
                  value={vendor}
                  onChange={(e) => {
                    setVendor(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="terminal-model" className="leading-6">
                  {t('paymentTerminals.fields.model')}
                </Label>
                <Input
                  id="terminal-model"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="terminal-serial" className="leading-6">
                  {t('paymentTerminals.fields.serialNumber')}
                </Label>
                <Input
                  id="terminal-serial"
                  value={serialNumber}
                  onChange={(e) => {
                    setSerialNumber(e.target.value);
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('paymentTerminals.new.pairingTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {canPair ? (
              <PairingFields
                idPrefix="terminal-new"
                value={pairing}
                onChange={(next) => {
                  setPairing(next);
                  create.reset();
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('paymentTerminals.new.pairingNeedsPermission')}
              </p>
            )}
            {!paired && (
              <div className="space-y-2">
                <Label htmlFor="terminal-site" className="leading-6">
                  {t('paymentTerminals.fields.site')}
                </Label>
                <Select
                  id="terminal-site"
                  value={siteId}
                  className={shown.siteId != null ? 'border-destructive' : ''}
                  onChange={(e) => {
                    setSiteId(e.target.value);
                  }}
                >
                  <option value="">
                    {allSites
                      ? t('paymentTerminals.new.noSite')
                      : t('paymentTerminals.new.selectSite')}
                  </option>
                  {(sites?.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                {shown.siteId != null && <p className="text-sm text-destructive">{shown.siteId}</p>}
                <p className="text-xs text-muted-foreground">
                  {t('paymentTerminals.new.siteHint')}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {create.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(create.error, t)}</p>
        )}
        <div className="flex justify-end gap-2">
          <CancelButton
            onClick={() => {
              void navigate('/payment-terminals');
            }}
          />
          <CreateButton
            label={t('paymentTerminals.new.submit')}
            type="submit"
            disabled={create.isPending}
          />
        </div>
      </form>
    </div>
  );
}
