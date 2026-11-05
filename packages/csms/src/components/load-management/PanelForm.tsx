// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogForm,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { api } from '@/lib/api';
import {
  PANEL_VOLTAGES,
  SUB_PANEL_PHASE_CONNECTIONS,
  computeMaxContinuousKw,
  isPanelVoltageAllowed,
  isSubPanelPhaseConnectionAllowed,
} from '@evtivity/lib/load-allocation';
import { formatNumber } from '@/lib/formatting';
import { getErrorMessage } from '@/lib/error-message';
import {
  flattenPanelNodes,
  parentPanelIds,
  refusedField,
  type TransformerItem,
  type TreeNode,
} from './load-management-types';

interface PanelStatus {
  type?: 'panel' | 'circuit' | 'transformer';
  id: string;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  safetyMarginKw: number;
  oversubscriptionRatio: number;
  phaseConnections?: string | null;
  currentDrawKw: number;
  availableKw: number;
  utilization: number;
  circuits: unknown[];
  childPanels: PanelStatus[];
  unmanagedLoads: unknown[];
}

interface PanelFormProps {
  siteId: string;
  panel?: PanelStatus;
  panels: PanelStatus[];
  /** The site's transformers, for Fed by Transformer. */
  transformers?: TransformerItem[];
  /** The parent of a new panel (Add Sub-Panel). */
  defaultParentPanelId?: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * The transformers that may feed a panel: a top-level panel takes a rated
 * service transformer, a sub-panel a rated step-down transformer fed from
 * its parent (the tree writer's rules).
 */
export function transformerOptionsFor(
  transformers: TransformerItem[],
  parentPanelId: string | null,
): TransformerItem[] {
  return transformers.filter((tx) => {
    if (tx.ratedKva == null) return false;
    if (parentPanelId == null) return tx.kind === 'service';
    return tx.kind === 'step_down' && tx.fedFromPanelId === parentPanelId;
  });
}

export function PanelForm({
  siteId,
  panel,
  panels,
  open,
  transformers = [],
  defaultParentPanelId,
  onClose,
  onSaved,
}: PanelFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const isEdit = panel != null;

  const [name, setName] = useState('');
  const [parentPanelId, setParentPanelId] = useState<string | null>(null);
  const [breakerRatingAmps, setBreakerRatingAmps] = useState(200);
  const [voltageV, setVoltageV] = useState(240);
  const [phases, setPhases] = useState(1);
  const [safetyMarginKw, setSafetyMarginKw] = useState('0');
  const [oversubscriptionRatio, setOversubscriptionRatio] = useState('1');
  const [phaseConnections, setPhaseConnections] = useState<string | null>(null);
  const [transformerId, setTransformerId] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      if (panel != null) {
        setName(panel.name);
        setParentPanelId(null);
        setBreakerRatingAmps(panel.breakerRatingAmps);
        setVoltageV(panel.voltageV);
        setPhases(panel.phases);
        setSafetyMarginKw(String(panel.safetyMarginKw));
        setOversubscriptionRatio(String(panel.oversubscriptionRatio));
        setPhaseConnections(panel.phaseConnections ?? null);
        setTransformerId(transformers.find((tx) => tx.panelIds.includes(panel.id))?.id ?? null);
      } else {
        setName('');
        setParentPanelId(defaultParentPanelId ?? null);
        setTransformerId(null);
        setBreakerRatingAmps(200);
        setVoltageV(240);
        setPhases(1);
        setSafetyMarginKw('0');
        setOversubscriptionRatio('1');
        setPhaseConnections(null);
      }
      setHasSubmitted(false);
    }
    // The transformer list refetches with the tab; only opening the form
    // (or another panel) resets the fields.
  }, [open, panel, defaultParentPanelId]);

  // A new panel picks its parent; an existing one keeps it (the panel PATCH
  // does not move a panel), so its form shows no parent select.
  const availableParents = useMemo(
    () => (isEdit ? [] : flattenPanelNodes(panels)),
    [panels, isEdit],
  );

  const effectiveParentId = useMemo(
    () => (isEdit ? (parentPanelIds(panels as TreeNode[]).get(panel.id) ?? null) : parentPanelId),
    [panels, isEdit, panel, parentPanelId],
  );

  // The parent decides whether the feeding phases apply.
  const parentPhases = useMemo(
    () => flattenPanelNodes(panels).find((p) => p.id === effectiveParentId)?.phases ?? null,
    [panels, effectiveParentId],
  );

  const transformerOptions = useMemo(
    () => transformerOptionsFor(transformers, effectiveParentId),
    [transformers, effectiveParentId],
  );
  // A link the options no longer offer (a new parent) is dropped.
  const selectedTransformerId =
    transformerId != null && transformerOptions.some((tx) => tx.id === transformerId)
      ? transformerId
      : null;
  const showPhaseConnections = isSubPanelPhaseConnectionAllowed(phases, parentPhases);

  const maxContinuousKw = computeMaxContinuousKw(breakerRatingAmps, voltageV, phases);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        ...(isEdit ? {} : { parentPanelId }),
        breakerRatingAmps,
        voltageV,
        phases,
        safetyMarginKw: Number(safetyMarginKw),
        oversubscriptionRatio: Number(oversubscriptionRatio),
        // On edit, null clears the feeding phases (the load counts on every
        // parent phase).
        ...(showPhaseConnections && phaseConnections != null
          ? { phaseConnections }
          : isEdit
            ? { phaseConnections: null }
            : {}),
        // On edit, null clears the link.
        ...(selectedTransformerId != null || isEdit
          ? { transformerId: selectedTransformerId }
          : {}),
      };
      if (isEdit) {
        return api.patch(`/v1/sites/${siteId}/panels/${panel.id}`, body);
      }
      return api.post(`/v1/sites/${siteId}/panels`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!isPanelVoltageAllowed(voltageV, phases)) {
      errors.voltageV = t('loadManagement.threePhaseVoltageHint');
    }
    const margin = Number(safetyMarginKw);
    if (safetyMarginKw.trim() === '') errors.safetyMarginKw = t('validation.required');
    else if (!Number.isFinite(margin)) errors.safetyMarginKw = t('validation.invalidNumber');
    const ratio = Number(oversubscriptionRatio);
    if (oversubscriptionRatio.trim() === '') {
      errors.oversubscriptionRatio = t('validation.required');
    } else if (!Number.isFinite(ratio)) {
      errors.oversubscriptionRatio = t('validation.invalidNumber');
    } else if (ratio < 1) {
      errors.oversubscriptionRatio = t('validation.min', { min: 1 });
    } else if (ratio > 3) {
      errors.oversubscriptionRatio = t('validation.max', { max: 3 });
    }
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate();
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
            {isEdit ? t('loadManagement.editPanel') : t('loadManagement.addPanel')}
          </DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit}>
          <DialogBody className="grid gap-6">
            <div className="grid gap-2">
              <Label htmlFor="panel-name">{t('loadManagement.panelName')}</Label>
              <Input
                id="panel-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                required
              />
            </div>

            {availableParents.length > 0 && (
              <div className="grid gap-2">
                <Label htmlFor="parent-panel">{t('loadManagement.parentPanel')}</Label>
                <Select
                  id="parent-panel"
                  value={parentPanelId ?? ''}
                  onChange={(e) => {
                    setParentPanelId(e.target.value || null);
                  }}
                >
                  <option value="">{t('loadManagement.noParent')}</option>
                  {availableParents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="grid gap-2">
                <Label htmlFor="breaker-rating">{t('loadManagement.breakerRating')}</Label>
                <Input
                  id="breaker-rating"
                  type="number"
                  min={1}
                  value={breakerRatingAmps}
                  onChange={(e) => {
                    setBreakerRatingAmps(Number(e.target.value));
                  }}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="voltage">{t('loadManagement.voltage')}</Label>
                <Select
                  id="voltage"
                  value={voltageV}
                  onChange={(e) => {
                    setVoltageV(Number(e.target.value));
                  }}
                >
                  {PANEL_VOLTAGES.map((v) => (
                    <option key={v} value={v}>
                      {v}V
                    </option>
                  ))}
                </Select>
                {hasSubmitted && errors.voltageV != null ? (
                  <p className="text-sm text-destructive">{errors.voltageV}</p>
                ) : (
                  phases === 3 && (
                    <p className="text-xs text-muted-foreground">
                      {t('loadManagement.threePhaseVoltageHint')}
                    </p>
                  )
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="grid gap-2">
                <Label htmlFor="phases">{t('loadManagement.phases')}</Label>
                <Select
                  id="phases"
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
                <Label htmlFor="safety-margin">{t('loadManagement.safetyMargin')}</Label>
                <DecimalInput
                  id="safety-margin"
                  value={safetyMarginKw}
                  onChange={setSafetyMarginKw}
                  className={hasSubmitted && errors.safetyMarginKw ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.safetyMarginKw && (
                  <p className="text-sm text-destructive">{errors.safetyMarginKw}</p>
                )}
              </div>
            </div>

            {showPhaseConnections && (
              <div className="grid gap-2">
                <Label htmlFor="panel-phase-connections">
                  {t('loadManagement.subPanelPhaseConnections')}
                </Label>
                <Select
                  id="panel-phase-connections"
                  value={phaseConnections ?? ''}
                  onChange={(e) => {
                    setPhaseConnections(e.target.value || null);
                  }}
                >
                  <option value="">{t('loadManagement.subPanelPhaseUnknown')}</option>
                  {SUB_PANEL_PHASE_CONNECTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value.replace(/(L\d)(?=L)/g, '$1+')}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('loadManagement.subPanelPhaseConnectionsHint')}
                </p>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="panel-transformer">{t('loadManagement.fedByTransformer')}</Label>
              <Select
                id="panel-transformer"
                value={selectedTransformerId ?? ''}
                onChange={(e) => {
                  setTransformerId(e.target.value || null);
                }}
                className={
                  refusedField(mutation.error) === 'transformerId' ? 'border-destructive' : ''
                }
              >
                <option value="">{t('loadManagement.fedByTransformerNone')}</option>
                {transformerOptions.map((tx) => (
                  <option key={tx.id} value={tx.id}>
                    {tx.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {effectiveParentId == null
                  ? t('loadManagement.fedByTransformerHelpTop')
                  : t('loadManagement.fedByTransformerHelpSub')}
              </p>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="oversubscription-ratio">
                {t('loadManagement.oversubscriptionRatio')}
              </Label>
              <DecimalInput
                id="oversubscription-ratio"
                value={oversubscriptionRatio}
                onChange={setOversubscriptionRatio}
                className={hasSubmitted && errors.oversubscriptionRatio ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.oversubscriptionRatio && (
                <p className="text-sm text-destructive">{errors.oversubscriptionRatio}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('loadManagement.oversubscriptionWarning')}
              </p>
            </div>

            <div className="rounded-md bg-muted p-3">
              <p className="text-sm text-muted-foreground">
                {t('loadManagement.maxContinuousPower')}
              </p>
              <p className="text-lg font-semibold">{formatNumber(maxContinuousKw, 1)} kW</p>
              <p className="text-xs text-muted-foreground">{t('loadManagement.necRule')}</p>
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
