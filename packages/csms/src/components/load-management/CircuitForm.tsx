// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
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

interface CircuitStatus {
  id: string;
  name: string;
  breakerRatingAmps: number;
  maxContinuousKw: number;
  currentDrawKw: number;
  availableKw: number;
  phaseConnections?: string | null;
  stations: unknown[];
  unmanagedLoads: unknown[];
}

interface CircuitFormProps {
  siteId: string;
  panelId: string;
  panelVoltageV: number;
  panelPhases: number;
  circuit?: CircuitStatus;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function computeMaxContinuousKw(amps: number, voltage: number, phases: number): number {
  return (amps * voltage * phases * 0.8) / 1000;
}

export function CircuitForm({
  siteId,
  panelId,
  panelVoltageV,
  panelPhases,
  circuit,
  open,
  onClose,
  onSaved,
}: CircuitFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const isEdit = circuit != null;

  const [name, setName] = useState('');
  const [breakerRatingAmps, setBreakerRatingAmps] = useState(40);
  const [phaseConnections, setPhaseConnections] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      if (circuit != null) {
        setName(circuit.name);
        setBreakerRatingAmps(circuit.breakerRatingAmps);
        setPhaseConnections(circuit.phaseConnections ?? null);
      } else {
        setName('');
        setBreakerRatingAmps(40);
        setPhaseConnections(null);
      }
    }
  }, [open, circuit]);

  const maxContinuousKw = computeMaxContinuousKw(breakerRatingAmps, panelVoltageV, panelPhases);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name, breakerRatingAmps };
      if (phaseConnections != null) body.phaseConnections = phaseConnections;
      if (isEdit) {
        return api.patch(`/v1/sites/${siteId}/panels/${panelId}/circuits/${circuit.id}`, body);
      }
      return api.post(`/v1/sites/${siteId}/panels/${panelId}/circuits`, body);
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
            {isEdit ? t('loadManagement.editCircuit') : t('loadManagement.addCircuit')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="circuit-name">{t('loadManagement.circuitName')}</Label>
            <Input
              id="circuit-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="circuit-breaker">{t('loadManagement.breakerRating')}</Label>
            <Input
              id="circuit-breaker"
              type="number"
              min={1}
              value={breakerRatingAmps}
              onChange={(e) => {
                setBreakerRatingAmps(Number(e.target.value));
              }}
              required
            />
          </div>

          {panelPhases === 3 && (
            <div className="grid gap-2">
              <Label htmlFor="phase-connections">{t('loadManagement.phaseConnections')}</Label>
              <Select
                id="phase-connections"
                value={phaseConnections ?? ''}
                onChange={(e) => {
                  setPhaseConnections(e.target.value || null);
                }}
              >
                <option value="">{t('loadManagement.phaseAuto')}</option>
                <option value="L1">L1</option>
                <option value="L2">L2</option>
                <option value="L3">L3</option>
                <option value="L1L2">L1+L2</option>
                <option value="L1L3">L1+L3</option>
                <option value="L2L3">L2+L3</option>
                <option value="L1L2L3">L1+L2+L3</option>
              </Select>
            </div>
          )}

          <div className="rounded-md bg-muted p-3">
            <p className="text-sm text-muted-foreground">
              {t('loadManagement.maxContinuousPower')}
            </p>
            <p className="text-lg font-semibold">{maxContinuousKw.toFixed(1)} kW</p>
            <p className="text-xs text-muted-foreground">
              {t('loadManagement.necRule')} ({panelVoltageV}V, {panelPhases}ph)
            </p>
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
