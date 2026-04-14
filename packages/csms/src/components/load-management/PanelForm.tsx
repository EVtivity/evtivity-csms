// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { api } from '@/lib/api';

interface PanelStatus {
  id: string;
  name: string;
  breakerRatingAmps: number;
  voltageV: number;
  phases: number;
  maxContinuousKw: number;
  safetyMarginKw: number;
  oversubscriptionRatio: number;
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
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function flattenPanels(panels: PanelStatus[]): PanelStatus[] {
  const result: PanelStatus[] = [];
  for (const panel of panels) {
    result.push(panel);
    if (panel.childPanels.length > 0) {
      result.push(...flattenPanels(panel.childPanels));
    }
  }
  return result;
}

function computeMaxContinuousKw(amps: number, voltage: number, phases: number): number {
  return (amps * voltage * phases * 0.8) / 1000;
}

export function PanelForm({
  siteId,
  panel,
  panels,
  open,
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
  const [safetyMarginKw, setSafetyMarginKw] = useState(0);
  const [oversubscriptionRatio, setOversubscriptionRatio] = useState(1.0);

  useEffect(() => {
    if (open) {
      if (panel != null) {
        setName(panel.name);
        setParentPanelId(null);
        setBreakerRatingAmps(panel.breakerRatingAmps);
        setVoltageV(panel.voltageV);
        setPhases(panel.phases);
        setSafetyMarginKw(panel.safetyMarginKw);
        setOversubscriptionRatio(panel.oversubscriptionRatio);
      } else {
        setName('');
        setParentPanelId(null);
        setBreakerRatingAmps(200);
        setVoltageV(240);
        setPhases(1);
        setSafetyMarginKw(0);
        setOversubscriptionRatio(1.0);
      }
    }
  }, [open, panel]);

  const availableParents = useMemo(() => {
    const flat = flattenPanels(panels);
    if (isEdit) {
      return flat.filter((p) => p.id !== panel.id);
    }
    return flat;
  }, [panels, isEdit, panel]);

  const maxContinuousKw = computeMaxContinuousKw(breakerRatingAmps, voltageV, phases);

  const mutation = useMutation({
    mutationFn: async () => {
      const body = {
        name,
        parentPanelId,
        breakerRatingAmps,
        voltageV,
        phases,
        safetyMarginKw,
        oversubscriptionRatio,
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

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('loadManagement.editPanel') : t('loadManagement.addPanel')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-6">
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                <option value={120}>120V</option>
                <option value={208}>208V</option>
                <option value={240}>240V</option>
                <option value={277}>277V</option>
                <option value={480}>480V</option>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <Input
                id="safety-margin"
                type="number"
                min={0}
                step={0.1}
                value={safetyMarginKw}
                onChange={(e) => {
                  setSafetyMarginKw(Number(e.target.value));
                }}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="oversubscription-ratio">
              {t('loadManagement.oversubscriptionRatio')}
            </Label>
            <Input
              id="oversubscription-ratio"
              type="number"
              min={1.0}
              max={3.0}
              step={0.1}
              value={oversubscriptionRatio}
              onChange={(e) => {
                setOversubscriptionRatio(Number(e.target.value));
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('loadManagement.oversubscriptionWarning')}
            </p>
          </div>

          <div className="rounded-md bg-muted p-3">
            <p className="text-sm text-muted-foreground">
              {t('loadManagement.maxContinuousPower')}
            </p>
            <p className="text-lg font-semibold">{maxContinuousKw.toFixed(1)} kW</p>
            <p className="text-xs text-muted-foreground">{t('loadManagement.necRule')}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <SaveButton isPending={mutation.isPending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
