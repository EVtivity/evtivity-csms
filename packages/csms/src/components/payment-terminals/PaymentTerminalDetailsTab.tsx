// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Link2, Unlink } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IdText } from '@/components/ui/id-text';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TabPanel } from '@/components/ui/tab-panel';
import { useToast } from '@/components/ui/toast';
import { DisableButton } from '@/components/disable-button';
import { EnableButton } from '@/components/enable-button';
import { RemoveButton } from '@/components/remove-button';
import { SaveButton } from '@/components/save-button';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatDateTime } from '@/lib/timezone';
import { PairingFields, type PairingValue } from './PairingFields';
import { TerminalOnlineStatus } from './PaymentTerminalsTable';
import { TerminalTestPaymentPanel } from './TerminalTestPaymentPanel';
import {
  PAYMENT_TERMINALS_KEY,
  terminalName,
  terminalPairingLabel,
  terminalProviderName,
  type PaymentTerminal,
} from './payment-terminal-types';

interface DetailsTabProps {
  terminal: PaymentTerminal;
  timezone: string;
}

/** The Details tab: the terminal's fields, its edit form, its pairing and a test payment. */
export function PaymentTerminalDetailsTab({
  terminal,
  timezone,
}: DetailsTabProps): React.JSX.Element {
  const canWrite = useHasPermission('paymentTerminals:write');
  const hasStationsWrite = useHasPermission('stations:write');
  const hasPaymentsWrite = useHasPermission('payments:write');
  // Pairing also needs stations:write, a test payment payments:write (as their routes do).
  const canPair = canWrite && hasStationsWrite;
  const canPay = canWrite && hasPaymentsWrite;
  return (
    <>
      <TerminalInfoPanel terminal={terminal} timezone={timezone} />
      <TerminalPairingPanel terminal={terminal} canPair={canPair} />
      {canPay && <TerminalTestPaymentPanel terminal={terminal} />}
      {canWrite && <TerminalEditPanel terminal={terminal} />}
    </>
  );
}

function TerminalInfoPanel({ terminal, timezone }: DetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('paymentTerminals:write');
  const [statusOpen, setStatusOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const active = terminal.status === 'active';
  const na = t('common.na');

  const setStatus = useMutation({
    mutationFn: () =>
      api.post(`/v1/payment-terminals/${terminal.id}/status`, {
        status: active ? 'inactive' : 'active',
      }),
    onSuccess: () => {
      setStatusOpen(false);
      toast({
        variant: 'success',
        title: active
          ? t('paymentTerminals.detail.deactivateSuccess')
          : t('paymentTerminals.detail.reactivateSuccess'),
      });
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['audit', 'payment_terminal'] });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/v1/payment-terminals/${terminal.id}`),
    onSuccess: () => {
      setDeleteOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.detail.deleteSuccess') });
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
      void navigate('/payment-terminals');
    },
  });

  const statusLabel = active
    ? t('paymentTerminals.detail.deactivate')
    : t('paymentTerminals.detail.reactivate');

  return (
    <TabPanel
      title={t('common.details')}
      actions={
        canWrite ? (
          <div className="flex flex-wrap gap-2">
            {active ? (
              <DisableButton
                label={statusLabel}
                onClick={() => {
                  setStatusOpen(true);
                }}
              />
            ) : (
              <EnableButton
                label={statusLabel}
                onClick={() => {
                  setStatusOpen(true);
                }}
              />
            )}
            <RemoveButton
              label={t('paymentTerminals.detail.delete')}
              onClick={() => {
                remove.reset();
                setDeleteOpen(true);
              }}
            />
          </div>
        ) : undefined
      }
      bodyClassName="space-y-4"
    >
      {!terminal.hasDisplay && (
        <Alert variant="info" data-testid="terminal-no-display">
          <Info className="h-4 w-4" />
          <AlertDescription>{t('paymentTerminals.detail.noDisplayNote')}</AlertDescription>
        </Alert>
      )}
      <DescriptionList>
        <DescriptionItem label={t('paymentTerminals.fields.label')}>
          <span className="wrap-anywhere">{terminal.label ?? na}</span>
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.status')}>
          <Badge variant={active ? 'success' : 'secondary'}>
            {t(`paymentTerminals.status.${terminal.status}`)}
          </Badge>
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.online')}>
          <TerminalOnlineStatus terminal={terminal} timezone={timezone} />
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.provider')}>
          {terminalProviderName(t, terminal.provider)}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.providerDeviceId')}>
          {terminal.providerDeviceId == null ? na : <IdText value={terminal.providerDeviceId} />}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.vendor')}>
          {terminal.vendor ?? na}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.model')}>
          {terminal.model ?? na}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.serialNumber')}>
          {terminal.serialNumber ?? na}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.firmwareVersion')}>
          {terminal.firmwareVersion ?? na}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.site')}>
          {terminal.siteId != null ? (
            <Link to={`/sites/${terminal.siteId}`} className="text-link hover:underline">
              {terminal.siteName ?? terminal.siteId}
            </Link>
          ) : (
            na
          )}
        </DescriptionItem>
        <DescriptionItem label={t('paymentTerminals.fields.created')}>
          {formatDateTime(terminal.createdAt, timezone)}
        </DescriptionItem>
      </DescriptionList>
      <ConfirmDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        variant={active ? 'destructive' : 'default'}
        title={statusLabel}
        description={
          active
            ? t('paymentTerminals.detail.deactivateDescription')
            : t('paymentTerminals.detail.reactivateDescription')
        }
        confirmLabel={statusLabel}
        isPending={setStatus.isPending}
        onConfirm={() => {
          setStatus.mutate();
          return false;
        }}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('paymentTerminals.detail.delete')}
        description={t('paymentTerminals.detail.deleteDescription', {
          name: terminalName(terminal),
        })}
        confirmLabel={t('paymentTerminals.detail.delete')}
        isPending={remove.isPending}
        onConfirm={() => {
          remove.mutate();
          return false;
        }}
      >
        {remove.isError && (
          <p className="text-sm text-destructive" data-testid="terminal-delete-error">
            {getErrorMessage(remove.error, t)}
          </p>
        )}
      </ConfirmDialog>
    </TabPanel>
  );
}

function TerminalPairingPanel({
  terminal,
  canPair,
}: {
  terminal: PaymentTerminal;
  canPair: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pairOpen, setPairOpen] = useState(false);
  const [unpairOpen, setUnpairOpen] = useState(false);
  const [pairing, setPairing] = useState<PairingValue>({ stationId: '', evseId: '' });
  const [pairSubmitted, setPairSubmitted] = useState(false);
  const pairingLabel = terminalPairingLabel(t, terminal);

  function onPairingChanged(): void {
    void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
    void queryClient.invalidateQueries({ queryKey: ['audit', 'payment_terminal'] });
  }

  const pair = useMutation({
    mutationFn: (value: PairingValue) =>
      api.post(`/v1/payment-terminals/${terminal.id}/pair`, {
        stationId: value.stationId,
        evseId: value.evseId === '' ? null : value.evseId,
      }),
    onSuccess: () => {
      setPairOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.pairing.pairSuccess') });
      onPairingChanged();
    },
  });

  const unpair = useMutation({
    mutationFn: () => api.post(`/v1/payment-terminals/${terminal.id}/unpair`, {}),
    onSuccess: () => {
      setUnpairOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.pairing.unpairSuccess') });
      onPairingChanged();
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  const stationError =
    pairSubmitted && pairing.stationId === '' ? t('validation.selectRequired') : undefined;

  return (
    <TabPanel
      title={t('paymentTerminals.pairing.title')}
      description={t('paymentTerminals.pairing.description')}
      actions={
        canPair ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={pairingLabel == null ? 'default' : 'outline'}
              className="gap-1.5"
              onClick={() => {
                setPairing({
                  stationId: terminal.stationId ?? '',
                  evseId: terminal.evseId ?? '',
                });
                setPairSubmitted(false);
                pair.reset();
                setPairOpen(true);
              }}
            >
              <Link2 className="h-4 w-4" />
              {pairingLabel == null
                ? t('paymentTerminals.pairing.pair')
                : t('paymentTerminals.pairing.change')}
            </Button>
            {pairingLabel != null && (
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  setUnpairOpen(true);
                }}
              >
                <Unlink className="h-4 w-4" />
                {t('paymentTerminals.pairing.unpair')}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {terminal.stationId != null ? (
        <DescriptionList>
          <DescriptionItem label={t('paymentTerminals.pairing.station')}>
            <Link to={`/stations/${terminal.stationId}`} className="text-link hover:underline">
              {terminal.stationOcppId ?? terminal.stationId}
            </Link>
          </DescriptionItem>
          <DescriptionItem label={t('paymentTerminals.pairing.connector')}>
            {terminal.evseNumber != null
              ? t('paymentTerminals.connector', { number: terminal.evseNumber })
              : t('paymentTerminals.wholeStation')}
          </DescriptionItem>
        </DescriptionList>
      ) : (
        <p className="text-sm text-muted-foreground">{t('paymentTerminals.pairing.notPaired')}</p>
      )}
      <ConfirmDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        variant="default"
        asForm
        title={t('paymentTerminals.pairing.dialogTitle')}
        description={t('paymentTerminals.pairing.dialogDescription')}
        confirmLabel={t('paymentTerminals.pairing.pair')}
        isPending={pair.isPending}
        onConfirm={() => {
          setPairSubmitted(true);
          if (pairing.stationId === '') return false;
          pair.mutate(pairing);
          return false;
        }}
      >
        <PairingFields
          idPrefix="terminal-pair"
          value={pairing}
          onChange={(next) => {
            setPairing(next);
            pair.reset();
          }}
          stationError={stationError}
        />
        {pair.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(pair.error, t)}</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={unpairOpen}
        onOpenChange={setUnpairOpen}
        title={t('paymentTerminals.pairing.unpair')}
        description={t('paymentTerminals.pairing.unpairDescription', {
          station: pairingLabel ?? '',
        })}
        confirmLabel={t('paymentTerminals.pairing.unpair')}
        isPending={unpair.isPending}
        onConfirm={() => {
          unpair.mutate();
          return false;
        }}
      />
    </TabPanel>
  );
}

interface SiteOption {
  id: string;
  name: string;
}

/** Label, vendor, model and serial number; the site of an unpaired terminal for all-site users. */
function TerminalEditPanel({ terminal }: { terminal: PaymentTerminal }): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const allSites = useHasAllSiteAccess();
  const canMoveSite = allSites && terminal.stationId == null;
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const loaded = {
    label: terminal.label ?? '',
    vendor: terminal.vendor ?? '',
    model: terminal.model ?? '',
    serialNumber: terminal.serialNumber ?? '',
    siteId: terminal.siteId ?? '',
  };
  const [form, setForm] = useLoadedValues(loaded, () => {
    setHasSubmitted(false);
  });
  const dirty = (Object.keys(loaded) as (keyof typeof loaded)[]).some(
    (key) => form[key].trim() !== loaded[key],
  );

  const { data: sites } = useQuery({
    queryKey: ['sites', 'filter-options'],
    queryFn: () => api.get<{ data: SiteOption[]; total: number }>('/v1/sites?limit=100'),
    enabled: canMoveSite,
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<PaymentTerminal>(`/v1/payment-terminals/${terminal.id}`, body),
    onSuccess: () => {
      setForm((current) => ({
        label: current.label.trim(),
        vendor: current.vendor.trim(),
        model: current.model.trim(),
        serialNumber: current.serialNumber.trim(),
        siteId: current.siteId,
      }));
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
      void queryClient.invalidateQueries({ queryKey: ['audit', 'payment_terminal'] });
    },
  });

  const errors: Partial<Record<keyof typeof loaded, string>> = {};
  if (form.label.trim().length > 100) errors.label = t('validation.maxLength', { max: 100 });
  for (const key of ['vendor', 'model', 'serialNumber'] as const) {
    if (form[key].trim().length > 255) errors[key] = t('validation.maxLength', { max: 255 });
  }
  const shown = hasSubmitted ? errors : {};

  function update(patch: Partial<typeof form>): void {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || !dirty) return;
    const value = (text: string): string | null => (text.trim() === '' ? null : text.trim());
    const body: Record<string, unknown> = {
      label: value(form.label),
      vendor: value(form.vendor),
      model: value(form.model),
      serialNumber: value(form.serialNumber),
    };
    if (canMoveSite && form.siteId !== loaded.siteId) body.siteId = value(form.siteId);
    save.mutate(body);
  }

  const textField = (
    key: 'label' | 'vendor' | 'model' | 'serialNumber',
    labelKey:
      | 'paymentTerminals.fields.label'
      | 'paymentTerminals.fields.vendor'
      | 'paymentTerminals.fields.model'
      | 'paymentTerminals.fields.serialNumber',
  ): React.JSX.Element => (
    <div className="space-y-2">
      <Label htmlFor={`terminal-edit-${key}`} className="leading-6">
        {t(labelKey)}
      </Label>
      <Input
        id={`terminal-edit-${key}`}
        value={form[key]}
        className={shown[key] != null ? 'border-destructive' : ''}
        onChange={(e) => {
          update({ [key]: e.target.value });
        }}
      />
      {shown[key] != null && <p className="text-sm text-destructive">{shown[key]}</p>}
    </div>
  );

  return (
    <TabPanel title={t('paymentTerminals.detail.editTitle')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {textField('label', 'paymentTerminals.fields.label')}
          {textField('vendor', 'paymentTerminals.fields.vendor')}
          {textField('model', 'paymentTerminals.fields.model')}
          {textField('serialNumber', 'paymentTerminals.fields.serialNumber')}
          {canMoveSite && (
            <div className="space-y-2">
              <Label htmlFor="terminal-edit-site" className="leading-6">
                {t('paymentTerminals.fields.site')}
              </Label>
              <Select
                id="terminal-edit-site"
                value={form.siteId}
                onChange={(e) => {
                  update({ siteId: e.target.value });
                }}
              >
                <option value="">{t('paymentTerminals.new.noSite')}</option>
                {(sites?.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{t('paymentTerminals.new.siteHint')}</p>
            </div>
          )}
        </div>
        {save.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(save.error, t)}</p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-4">
          {save.isSuccess && !dirty && <p className="text-sm text-success">{t('common.saved')}</p>}
          {dirty && <p className="text-sm text-muted-foreground">{t('settings.unsavedChanges')}</p>}
          <SaveButton isPending={save.isPending} disabled={save.isPending || !dirty} />
        </div>
      </form>
    </TabPanel>
  );
}
