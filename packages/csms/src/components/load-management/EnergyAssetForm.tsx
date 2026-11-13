// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogForm,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import {
  ENERGY_ASSET_RATING_RANGE,
  ENERGY_ASSET_READING_TTL_RANGE,
  ENERGY_ASSET_RESERVE_RANGE,
} from '@evtivity/lib/energy-supply';
import {
  flattenPanelNodes,
  refusedField,
  type EnergyAssetItem,
  type TransformerItem,
  type TreeNode,
} from './load-management-types';
import { useSavedToast } from '@/components/saved-message';
import { useSolarCarportRow } from './use-solar-carport-row';

type AssetType = EnergyAssetItem['type'];
type Telemetry = EnergyAssetItem['telemetry'];

/** Connection select value: `transformer:<id>`, `panel:<id>`, or '' for none. */
export function connectionValue(
  asset: Pick<EnergyAssetItem, 'connectionTransformerId' | 'connectionPanelId'>,
): string {
  if (asset.connectionTransformerId != null) return `transformer:${asset.connectionTransformerId}`;
  if (asset.connectionPanelId != null) return `panel:${asset.connectionPanelId}`;
  return '';
}

/** The two connection fields of the API body for a connection select value. */
export function connectionFields(value: string): {
  connectionTransformerId: string | null;
  connectionPanelId: string | null;
} {
  if (value.startsWith('transformer:')) {
    return { connectionTransformerId: value.slice('transformer:'.length), connectionPanelId: null };
  }
  if (value.startsWith('panel:')) {
    return { connectionTransformerId: null, connectionPanelId: value.slice('panel:'.length) };
  }
  return { connectionTransformerId: null, connectionPanelId: null };
}

/** Maps an API `field` of a refused write to the form field it names. */
const FIELD_OF: Record<string, string> = {
  connectionTransformerId: 'connection',
  connectionPanelId: 'connection',
};

interface EnergyAssetFormProps {
  siteId: string;
  asset?: EnergyAssetItem | undefined;
  transformers: TransformerItem[];
  panels: TreeNode[];
  /** The installation accepts simulated readings (`simulatedEnergyAssetsAllowed`). */
  simulatedAllowed: boolean;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const text = (value: number | null | undefined): string => (value == null ? '' : String(value));

export function EnergyAssetForm({
  siteId,
  asset,
  transformers,
  panels,
  simulatedAllowed,
  open,
  onClose,
  onSaved,
}: EnergyAssetFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const savedToast = useSavedToast();
  const isEdit = asset != null;

  const [type, setType] = useState<AssetType>('battery');
  const [name, setName] = useState('');
  const [capacityKwh, setCapacityKwh] = useState('');
  const [peakKwp, setPeakKwp] = useState('');
  const [inverterKw, setInverterKw] = useState('');
  const [maxDischargeKw, setMaxDischargeKw] = useState('');
  const [maxChargeKw, setMaxChargeKw] = useState('');
  const [phases, setPhases] = useState(3);
  const [connection, setConnection] = useState('');
  const [gridCharging, setGridCharging] = useState<'never' | 'possible'>('possible');
  const [reservePercent, setReservePercent] = useState(String(ENERGY_ASSET_RESERVE_RANGE.default));
  const [telemetry, setTelemetry] = useState<Telemetry>('none');
  const [ttl, setTtl] = useState(String(ENERGY_ASSET_READING_TTL_RANGE.default));
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // The lot row a solar carport covers (parking lot, sites:write): stored
  // as its layout position after the asset is saved.
  const carport = useSolarCarportRow(siteId, open);
  const [solarRow, setSolarRow] = useState(0);
  // A new asset already stored by a try whose row save failed: a retry
  // changes it instead of adding a second one.
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(asset?.type ?? 'battery');
    setName(asset?.name ?? '');
    setCapacityKwh(text(asset?.capacityKwh));
    setPeakKwp(text(asset?.peakKwp));
    setInverterKw(text(asset?.inverterKw));
    setMaxDischargeKw(text(asset?.maxDischargeKw));
    setMaxChargeKw(text(asset?.maxChargeKw));
    setPhases(asset?.phases ?? 3);
    setConnection(asset != null ? connectionValue(asset) : '');
    setGridCharging(asset?.gridCharging ?? 'possible');
    setReservePercent(String(asset?.reservePercent ?? ENERGY_ASSET_RESERVE_RANGE.default));
    setTelemetry(asset?.telemetry ?? 'none');
    setTtl(String(asset?.readingTtlSeconds ?? ENERGY_ASSET_READING_TTL_RANGE.default));
    setHasSubmitted(false);
    setCreatedId(null);
  }, [open, asset]);

  // The canopy's row, once the layout is loaded.
  const { rowOf } = carport;
  useEffect(() => {
    if (open) setSolarRow(rowOf(asset?.id));
  }, [open, asset, rowOf]);
  const showsCarportRow = type === 'solar' && carport.available;

  const panelOptions = useMemo(() => flattenPanelNodes(panels), [panels]);
  // Simulated readings are offered where the installation allows them, and
  // kept on an asset that already has them.
  const showSimulated = simulatedAllowed || asset?.telemetry === 'simulated';

  function ratingError(value: string, integer: boolean): string | null {
    if (value.trim() === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      return t('validation.invalidNumber');
    }
    const min = integer ? ENERGY_ASSET_RATING_RANGE.min : 0.1;
    if (n < min) return t('validation.min', { min });
    if (n > ENERGY_ASSET_RATING_RANGE.max) {
      return t('validation.max', { max: ENERGY_ASSET_RATING_RANGE.max });
    }
    return null;
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const put = (field: string, message: string | null): void => {
      if (message != null) errors[field] = message;
    };
    if (name.trim() === '') errors.name = t('validation.required');
    else if (name.trim().length > 60) errors.name = t('validation.maxLength', { max: 60 });
    put('inverterKw', ratingError(inverterKw, false));
    if (type === 'battery') {
      put('capacityKwh', ratingError(capacityKwh, true));
      put('maxDischargeKw', ratingError(maxDischargeKw, false));
      put('maxChargeKw', ratingError(maxChargeKw, false));
      const reserve = Number(reservePercent);
      if (reservePercent.trim() === '') errors.reservePercent = t('validation.required');
      else if (!Number.isInteger(reserve)) errors.reservePercent = t('validation.invalidNumber');
      else if (reserve < ENERGY_ASSET_RESERVE_RANGE.min || reserve > ENERGY_ASSET_RESERVE_RANGE.max)
        errors.reservePercent = t('loadManagement.reserveRange');
    } else {
      put('peakKwp', ratingError(peakKwp, true));
    }
    if (telemetry !== 'none') {
      const seconds = Number(ttl);
      if (ttl.trim() === '') errors.readingTtlSeconds = t('validation.required');
      else if (
        !Number.isInteger(seconds) ||
        seconds < ENERGY_ASSET_READING_TTL_RANGE.min ||
        seconds > ENERGY_ASSET_READING_TTL_RANGE.max
      )
        errors.readingTtlSeconds = t('loadManagement.readingTtlHelp');
    }
    return errors;
  }

  const errors = getValidationErrors();

  const mutation = useMutation({
    mutationFn: async () => {
      const num = (value: string): number | null => (value.trim() === '' ? null : Number(value));
      const body: Record<string, unknown> = {
        ...(asset == null && createdId == null ? { type } : {}),
        name: name.trim(),
        inverterKw: num(inverterKw),
        phases,
        ...connectionFields(connection),
        telemetry,
        ...(telemetry !== 'none' ? { readingTtlSeconds: Number(ttl) } : {}),
      };
      if (type === 'battery') {
        body.capacityKwh = num(capacityKwh);
        body.maxDischargeKw = num(maxDischargeKw);
        body.maxChargeKw = num(maxChargeKw);
        body.gridCharging = gridCharging;
        body.reservePercent = Number(reservePercent);
      } else {
        body.peakKwp = num(peakKwp);
      }
      let assetId = asset?.id ?? createdId;
      if (assetId != null) {
        await api.patch(`/v1/sites/${siteId}/energy-assets/${assetId}`, body);
      } else {
        const created = await api.post<{ id: string }>(`/v1/sites/${siteId}/energy-assets`, body);
        assetId = created.id;
        setCreatedId(assetId);
      }
      if (showsCarportRow) await carport.save(assetId, solarRow);
    },
    onSuccess: () => {
      savedToast();
      onSaved();
      onClose();
    },
  });

  const apiField = refusedField(mutation.error);
  const serverField = apiField == null ? null : (FIELD_OF[apiField] ?? apiField);

  function fieldError(field: string): string | null {
    return hasSubmitted ? (errors[field] ?? null) : null;
  }

  function invalidClass(field: string): string {
    return fieldError(field) != null || serverField === field ? 'border-destructive' : '';
  }

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate();
  }

  function decimalField(
    id: string,
    field: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    help?: string,
  ): React.JSX.Element {
    const error = fieldError(field);
    return (
      <div className="grid gap-2">
        <Label htmlFor={id}>{label}</Label>
        <DecimalInput id={id} value={value} onChange={onChange} className={invalidClass(field)} />
        {error != null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          help != null && <p className="text-xs text-muted-foreground">{help}</p>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent scrollable className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('loadManagement.editEnergyAsset') : t('loadManagement.addEnergyAsset')}
          </DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit} noValidate>
          <DialogBody className="grid gap-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="grid gap-2">
                <Label htmlFor="asset-type">{t('loadManagement.assetType')}</Label>
                <Select
                  id="asset-type"
                  value={type}
                  disabled={isEdit}
                  onChange={(e) => {
                    setType(e.target.value as AssetType);
                  }}
                >
                  <option value="battery">{t('loadManagement.assetTypeBattery')}</option>
                  <option value="solar">{t('loadManagement.assetTypeSolar')}</option>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="asset-name">{t('loadManagement.assetName')}</Label>
                <Input
                  id="asset-name"
                  value={name}
                  maxLength={60}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={invalidClass('name')}
                />
                {fieldError('name') != null && (
                  <p className="text-sm text-destructive">{fieldError('name')}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {type === 'battery'
                ? decimalField(
                    'asset-capacity',
                    'capacityKwh',
                    t('loadManagement.capacityKwh'),
                    capacityKwh,
                    setCapacityKwh,
                  )
                : decimalField(
                    'asset-peak',
                    'peakKwp',
                    t('loadManagement.peakKwp'),
                    peakKwp,
                    setPeakKwp,
                  )}
              {decimalField(
                'asset-inverter',
                'inverterKw',
                t('loadManagement.inverterKw'),
                inverterKw,
                setInverterKw,
                t('loadManagement.inverterKwHelp'),
              )}
            </div>

            {showsCarportRow && (
              <div className="grid gap-2">
                <Label htmlFor="asset-solar-row">{t('sites.layoutSettings.solarRow')}</Label>
                <Select
                  id="asset-solar-row"
                  value={String(solarRow)}
                  onChange={(e) => {
                    setSolarRow(Number(e.target.value));
                  }}
                >
                  {Array.from({ length: carport.rows }, (_, r) => (
                    <option key={r} value={r}>
                      {t('sites.layoutSettings.rowNumber', { n: r + 1 })}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">{t('loadManagement.solarRowHelp')}</p>
              </div>
            )}

            {type === 'battery' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {decimalField(
                  'asset-discharge',
                  'maxDischargeKw',
                  t('loadManagement.maxDischargeKw'),
                  maxDischargeKw,
                  setMaxDischargeKw,
                )}
                {decimalField(
                  'asset-charge',
                  'maxChargeKw',
                  t('loadManagement.maxChargeKw'),
                  maxChargeKw,
                  setMaxChargeKw,
                )}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="grid gap-2">
                <Label htmlFor="asset-phases">{t('loadManagement.phases')}</Label>
                <Select
                  id="asset-phases"
                  value={phases}
                  onChange={(e) => {
                    setPhases(Number(e.target.value));
                  }}
                >
                  <option value={1}>1</option>
                  <option value={3}>3</option>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="asset-connection">{t('loadManagement.connectionPoint')}</Label>
                <Select
                  id="asset-connection"
                  value={connection}
                  onChange={(e) => {
                    setConnection(e.target.value);
                  }}
                  className={invalidClass('connection')}
                >
                  <option value="">{t('loadManagement.connectionNone')}</option>
                  {transformers.length > 0 && (
                    <optgroup label={t('loadManagement.connectionTransformers')}>
                      {transformers.map((tx) => (
                        <option key={tx.id} value={`transformer:${tx.id}`}>
                          {tx.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {panelOptions.length > 0 && (
                    <optgroup label={t('loadManagement.connectionPanels')}>
                      {panelOptions.map((p) => (
                        <option key={p.id} value={`panel:${p.id}`}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </div>
            </div>
            <p className="-mt-4 text-xs text-muted-foreground">
              {t('loadManagement.connectionHelp')}
            </p>

            {type === 'battery' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                <div className="grid gap-2">
                  <Label htmlFor="asset-grid-charging">{t('loadManagement.gridCharging')}</Label>
                  <Select
                    id="asset-grid-charging"
                    value={gridCharging}
                    onChange={(e) => {
                      setGridCharging(e.target.value as 'never' | 'possible');
                    }}
                  >
                    <option value="possible">{t('loadManagement.gridChargingPossible')}</option>
                    <option value="never">{t('loadManagement.gridChargingNever')}</option>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.gridChargingHelp')}
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="asset-reserve">{t('loadManagement.reservePercent')}</Label>
                  <Input
                    id="asset-reserve"
                    type="number"
                    inputMode="numeric"
                    value={reservePercent}
                    onChange={(e) => {
                      setReservePercent(e.target.value);
                    }}
                    className={invalidClass('reservePercent')}
                  />
                  {fieldError('reservePercent') != null ? (
                    <p className="text-sm text-destructive">{fieldError('reservePercent')}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t('loadManagement.reserveHelp')}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="grid gap-2">
                <Label htmlFor="asset-telemetry">{t('loadManagement.telemetry')}</Label>
                <Select
                  id="asset-telemetry"
                  value={telemetry}
                  onChange={(e) => {
                    setTelemetry(e.target.value as Telemetry);
                  }}
                  className={invalidClass('telemetry')}
                >
                  <option value="none">{t('loadManagement.telemetryNone')}</option>
                  <option value="api">{t('loadManagement.telemetryApi')}</option>
                  {showSimulated && (
                    <option value="simulated">{t('loadManagement.telemetrySimulated')}</option>
                  )}
                </Select>
                <p className="text-xs text-muted-foreground">{t('loadManagement.telemetryHelp')}</p>
              </div>
              {telemetry !== 'none' && (
                <div className="grid gap-2">
                  <Label htmlFor="asset-ttl">{t('loadManagement.readingTtl')}</Label>
                  <Input
                    id="asset-ttl"
                    type="number"
                    inputMode="numeric"
                    value={ttl}
                    onChange={(e) => {
                      setTtl(e.target.value);
                    }}
                    className={invalidClass('readingTtlSeconds')}
                  />
                  <p
                    className={
                      fieldError('readingTtlSeconds') != null
                        ? 'text-sm text-destructive'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {t('loadManagement.readingTtlHelp')}
                  </p>
                </div>
              )}
            </div>
          </DialogBody>

          {mutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(mutation.error, t, 'loadManagement.saveFailed')}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <SaveButton isPending={mutation.isPending} />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
