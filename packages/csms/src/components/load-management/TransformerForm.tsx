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
import { formatNumber } from '@/lib/formatting';
import {
  PAD_MOUNT_TRANSFORMER_KVA,
  PANEL_VOLTAGES,
  STEP_DOWN_TRANSFORMER_KVA,
  TRANSFORMER_LOADING_LIMIT_RANGE,
  TRANSFORMER_POWER_FACTOR_RANGE,
  TRANSFORMER_RATED_KVA_RANGE,
  computeTransformerCapacityKw,
  isPanelVoltageAllowed,
  type TransformerKind,
} from '@evtivity/lib/load-allocation';
import {
  flattenPanelNodes,
  formatKva,
  refusedField,
  type TransformerItem,
  type TreeNode,
} from './load-management-types';

const CUSTOM = 'custom';
const UNRATED = '';

/** The standard kVA ratings the form offers for a kind of transformer. */
export function standardKvaRatings(kind: TransformerKind): readonly number[] {
  return kind === 'step_down' ? STEP_DOWN_TRANSFORMER_KVA : PAD_MOUNT_TRANSFORMER_KVA;
}

/** The kVA select value for a rating: a standard rating, CUSTOM, or UNRATED. */
export function kvaChoiceFor(kind: TransformerKind, ratedKva: number | null): string {
  if (ratedKva == null) return UNRATED;
  return standardKvaRatings(kind).includes(ratedKva) ? String(ratedKva) : CUSTOM;
}

interface TransformerFormProps {
  siteId: string;
  transformer?: TransformerItem;
  /** The site's hierarchy, for the panel that feeds a step-down transformer. */
  panels: TreeNode[];
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function TransformerForm({
  siteId,
  transformer,
  panels,
  open,
  onClose,
  onSaved,
}: TransformerFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const isEdit = transformer != null;

  const [kind, setKind] = useState<TransformerKind>('service');
  const [name, setName] = useState('');
  const [kvaChoice, setKvaChoice] = useState(UNRATED);
  const [customKva, setCustomKva] = useState('');
  const [phases, setPhases] = useState(3);
  const [voltage, setVoltage] = useState('');
  const [powerFactor, setPowerFactor] = useState(String(TRANSFORMER_POWER_FACTOR_RANGE.default));
  const [loadingLimit, setLoadingLimit] = useState(String(TRANSFORMER_LOADING_LIMIT_RANGE.default));
  const [safetyMargin, setSafetyMargin] = useState('0');
  const [fedFromPanelId, setFedFromPanelId] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    const k = transformer?.kind ?? 'service';
    setKind(k);
    setName(transformer?.name ?? '');
    const choice = kvaChoiceFor(k, transformer?.ratedKva ?? null);
    setKvaChoice(choice);
    setCustomKva(choice === CUSTOM ? String(transformer?.ratedKva ?? '') : '');
    setPhases(transformer?.phases ?? 3);
    setVoltage(transformer?.secondaryVoltageV != null ? String(transformer.secondaryVoltageV) : '');
    setPowerFactor(String(transformer?.powerFactor ?? TRANSFORMER_POWER_FACTOR_RANGE.default));
    setLoadingLimit(
      String(transformer?.loadingLimitPercent ?? TRANSFORMER_LOADING_LIMIT_RANGE.default),
    );
    setSafetyMargin(String(transformer?.safetyMarginKw ?? 0));
    setFedFromPanelId(transformer?.fedFromPanelId ?? '');
    setHasSubmitted(false);
  }, [open, transformer]);

  const panelOptions = useMemo(() => flattenPanelNodes(panels), [panels]);

  function changeKind(next: TransformerKind): void {
    // A standard rating of the old kind that the new kind does not list stays
    // as a custom value, so the rating is never lost.
    if (kvaChoice !== UNRATED && kvaChoice !== CUSTOM) {
      if (!standardKvaRatings(next).includes(Number(kvaChoice))) {
        setCustomKva(kvaChoice);
        setKvaChoice(CUSTOM);
      }
    }
    setKind(next);
  }

  const ratedKva: number | null =
    kvaChoice === UNRATED ? null : kvaChoice === CUSTOM ? Number(customKva) : Number(kvaChoice);

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim() === '') errors.name = t('validation.required');
    else if (name.trim().length > 60) errors.name = t('validation.maxLength', { max: 60 });
    if (kvaChoice === CUSTOM) {
      const kva = Number(customKva);
      if (customKva.trim() === '') errors.ratedKva = t('validation.required');
      else if (!Number.isFinite(kva)) errors.ratedKva = t('validation.invalidNumber');
      else if (kva < TRANSFORMER_RATED_KVA_RANGE.min)
        errors.ratedKva = t('validation.min', { min: TRANSFORMER_RATED_KVA_RANGE.min });
      else if (kva > TRANSFORMER_RATED_KVA_RANGE.max)
        errors.ratedKva = t('validation.max', { max: TRANSFORMER_RATED_KVA_RANGE.max });
    }
    if (voltage !== '' && !isPanelVoltageAllowed(Number(voltage), phases)) {
      errors.secondaryVoltageV = t('loadManagement.threePhaseVoltageHint');
    }
    const pf = Number(powerFactor);
    if (powerFactor.trim() === '') errors.powerFactor = t('validation.required');
    else if (!Number.isFinite(pf)) errors.powerFactor = t('validation.invalidNumber');
    else if (pf < TRANSFORMER_POWER_FACTOR_RANGE.min)
      errors.powerFactor = t('validation.min', { min: TRANSFORMER_POWER_FACTOR_RANGE.min });
    else if (pf > TRANSFORMER_POWER_FACTOR_RANGE.max)
      errors.powerFactor = t('validation.max', { max: TRANSFORMER_POWER_FACTOR_RANGE.max });
    const limit = Number(loadingLimit);
    if (loadingLimit.trim() === '') errors.loadingLimitPercent = t('validation.required');
    else if (!Number.isInteger(limit)) errors.loadingLimitPercent = t('validation.invalidNumber');
    else if (limit < TRANSFORMER_LOADING_LIMIT_RANGE.min)
      errors.loadingLimitPercent = t('validation.min', {
        min: TRANSFORMER_LOADING_LIMIT_RANGE.min,
      });
    else if (limit > TRANSFORMER_LOADING_LIMIT_RANGE.max)
      errors.loadingLimitPercent = t('validation.max', {
        max: TRANSFORMER_LOADING_LIMIT_RANGE.max,
      });
    const margin = Number(safetyMargin);
    if (safetyMargin.trim() === '') errors.safetyMarginKw = t('validation.required');
    else if (!Number.isFinite(margin)) errors.safetyMarginKw = t('validation.invalidNumber');
    else if (margin < 0) errors.safetyMarginKw = t('validation.min', { min: 0 });
    if (kind === 'step_down' && fedFromPanelId === '') {
      errors.fedFromPanelId = t('validation.selectRequired');
    }
    return errors;
  }

  const errors = getValidationErrors();

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        kind,
        name: name.trim(),
        ratedKva,
        phases,
        secondaryVoltageV: voltage === '' ? null : Number(voltage),
        powerFactor: Number(powerFactor),
        loadingLimitPercent: Number(loadingLimit),
        safetyMarginKw: Number(safetyMargin),
        fedFromPanelId: kind === 'step_down' ? fedFromPanelId : null,
      };
      if (isEdit) {
        return api.patch(`/v1/sites/${siteId}/transformers/${transformer.id}`, body);
      }
      return api.post(`/v1/sites/${siteId}/transformers`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const serverField = refusedField(mutation.error);

  function fieldError(field: string): string | null {
    if (hasSubmitted && errors[field] != null) return errors[field];
    return null;
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

  const capacityKw =
    ratedKva != null && Number.isFinite(ratedKva)
      ? computeTransformerCapacityKw(ratedKva, Number(powerFactor), Number(loadingLimit))
      : null;

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
            {isEdit ? t('loadManagement.editTransformer') : t('loadManagement.addTransformer')}
          </DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit} noValidate>
          <DialogBody className="grid gap-6">
            <div className="grid gap-2">
              <Label htmlFor="transformer-kind">{t('loadManagement.transformerKind')}</Label>
              <Select
                id="transformer-kind"
                value={kind}
                onChange={(e) => {
                  changeKind(e.target.value as TransformerKind);
                }}
                className={invalidClass('kind')}
              >
                <option value="service">{t('loadManagement.kindService')}</option>
                <option value="step_down">{t('loadManagement.kindStepDown')}</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                {kind === 'service'
                  ? t('loadManagement.kindServiceHelp')
                  : t('loadManagement.kindStepDownHelp')}
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="transformer-name">{t('loadManagement.transformerName')}</Label>
              <Input
                id="transformer-name"
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="transformer-kva">{t('loadManagement.ratedKva')}</Label>
                <Select
                  id="transformer-kva"
                  value={kvaChoice}
                  onChange={(e) => {
                    setKvaChoice(e.target.value);
                  }}
                  className={invalidClass('ratedKva')}
                >
                  <option value={UNRATED}>{t('loadManagement.ratedKvaUnknown')}</option>
                  {standardKvaRatings(kind).map((kva) => (
                    <option key={kva} value={String(kva)}>
                      {formatKva(kva)}
                    </option>
                  ))}
                  <option value={CUSTOM}>{t('loadManagement.ratedKvaCustom')}</option>
                </Select>
              </div>
              {kvaChoice === CUSTOM && (
                <div className="grid gap-2">
                  <Label htmlFor="transformer-custom-kva">{t('loadManagement.customKva')}</Label>
                  <DecimalInput
                    id="transformer-custom-kva"
                    value={customKva}
                    onChange={setCustomKva}
                    className={invalidClass('ratedKva')}
                  />
                  {fieldError('ratedKva') != null && (
                    <p className="text-sm text-destructive">{fieldError('ratedKva')}</p>
                  )}
                </div>
              )}
            </div>
            <p className="-mt-4 text-xs text-muted-foreground">
              {t('loadManagement.ratedKvaHelp')}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="transformer-phases">{t('loadManagement.phases')}</Label>
                <Select
                  id="transformer-phases"
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
                <Label htmlFor="transformer-voltage">{t('loadManagement.secondaryVoltage')}</Label>
                <Select
                  id="transformer-voltage"
                  value={voltage}
                  onChange={(e) => {
                    setVoltage(e.target.value);
                  }}
                  className={invalidClass('secondaryVoltageV')}
                >
                  <option value="">{t('loadManagement.voltageUnknown')}</option>
                  {PANEL_VOLTAGES.map((v) => (
                    <option key={v} value={String(v)}>
                      {v}V
                    </option>
                  ))}
                </Select>
                {fieldError('secondaryVoltageV') != null ? (
                  <p className="text-sm text-destructive">{fieldError('secondaryVoltageV')}</p>
                ) : (
                  phases === 3 && (
                    <p className="text-xs text-muted-foreground">
                      {t('loadManagement.threePhaseVoltageHint')}
                    </p>
                  )
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="transformer-power-factor">{t('loadManagement.powerFactor')}</Label>
                <DecimalInput
                  id="transformer-power-factor"
                  value={powerFactor}
                  onChange={setPowerFactor}
                  decimalScale={2}
                  className={invalidClass('powerFactor')}
                />
                {fieldError('powerFactor') != null ? (
                  <p className="text-sm text-destructive">{fieldError('powerFactor')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.powerFactorHelp')}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="transformer-loading-limit">
                  {t('loadManagement.loadingLimit')}
                </Label>
                <Input
                  id="transformer-loading-limit"
                  type="number"
                  inputMode="numeric"
                  value={loadingLimit}
                  onChange={(e) => {
                    setLoadingLimit(e.target.value);
                  }}
                  className={invalidClass('loadingLimitPercent')}
                />
                {fieldError('loadingLimitPercent') != null ? (
                  <p className="text-sm text-destructive">{fieldError('loadingLimitPercent')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.loadingLimitHelp')}
                  </p>
                )}
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="transformer-safety-margin">{t('loadManagement.safetyMargin')}</Label>
              <DecimalInput
                id="transformer-safety-margin"
                value={safetyMargin}
                onChange={setSafetyMargin}
                className={invalidClass('safetyMarginKw')}
              />
              {fieldError('safetyMarginKw') != null && (
                <p className="text-sm text-destructive">{fieldError('safetyMarginKw')}</p>
              )}
            </div>

            {kind === 'step_down' && (
              <div className="grid gap-2">
                <Label htmlFor="transformer-fed-from">{t('loadManagement.fedFromPanel')}</Label>
                <Select
                  id="transformer-fed-from"
                  value={fedFromPanelId}
                  onChange={(e) => {
                    setFedFromPanelId(e.target.value);
                  }}
                  className={invalidClass('fedFromPanelId')}
                >
                  <option value="">{t('loadManagement.selectPanel')}</option>
                  {panelOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                {fieldError('fedFromPanelId') != null ? (
                  <p className="text-sm text-destructive">{fieldError('fedFromPanelId')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.fedFromPanelHelp')}
                  </p>
                )}
              </div>
            )}

            <div className="rounded-md bg-muted p-3" data-testid="transformer-capacity">
              <p className="text-sm text-muted-foreground">
                {t('loadManagement.transformerCapacity')}
              </p>
              {capacityKw != null && Number.isFinite(capacityKw) ? (
                <>
                  <p className="text-lg font-semibold">{formatNumber(capacityKw, 1)} kW</p>
                  <p className="text-xs text-muted-foreground">
                    {t('loadManagement.transformerCapacityRule')}
                  </p>
                </>
              ) : (
                <p className="text-sm">{t('loadManagement.transformerCapacityUnrated')}</p>
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
