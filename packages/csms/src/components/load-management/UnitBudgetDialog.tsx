// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hasAtMostDecimals } from '@evtivity/lib/connector-power';
import { UNIT_BUDGET_MIN_AC_A } from '@evtivity/lib/load-allocation';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { SaveButton } from '@/components/save-button';
import { RemoveButton } from '@/components/remove-button';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import type { UnitBudgetUnit } from './StationUnitBudgetRows';

const CURRENT_MIN_A = UNIT_BUDGET_MIN_AC_A;
const CURRENT_MAX_A = 1000;
const POWER_MIN_KW = 0.01;
const POWER_MAX_KW = 5000;

type BudgetKind = 'ac' | 'dc';

/** Sets or removes the budget of one Station Unit (`PUT`, `DELETE .../units/:unitId/load-budget`). */
export function UnitBudgetDialog({
  siteId,
  stationId,
  unit,
  defaultPhases,
  open,
  onClose,
}: {
  siteId: string;
  stationId: string;
  unit: UnitBudgetUnit;
  /** The phases the API takes when none is sent (the station circuit); null on no circuit. */
  defaultPhases: number | null;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fixedKind: BudgetKind | null =
    unit.chargingKind === 'ac' || unit.chargingKind === 'dc' ? unit.chargingKind : null;
  const initialKind: BudgetKind = unit.budget?.kind ?? fixedKind ?? 'ac';
  const [kind, setKind] = useState<BudgetKind>(initialKind);
  const [current, setCurrent] = useState(
    unit.budget?.maxCurrentA != null ? String(unit.budget.maxCurrentA) : '',
  );
  const [phases, setPhases] = useState(
    unit.budget?.phases != null ? String(unit.budget.phases) : '',
  );
  const [power, setPower] = useState(
    unit.budget?.maxPowerKw != null ? String(unit.budget.maxPowerKw) : '',
  );
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setCurrent(unit.budget?.maxCurrentA != null ? String(unit.budget.maxCurrentA) : '');
    setPhases(unit.budget?.phases != null ? String(unit.budget.phases) : '');
    setPower(unit.budget?.maxPowerKw != null ? String(unit.budget.maxPowerKw) : '');
    setFieldError(null);
  }, [open, unit, initialKind]);

  const url = `/v1/sites/${siteId}/stations/${stationId}/units/${unit.unitId}/load-budget`;
  function done(): void {
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
    onClose();
  }
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put(url, body),
    onSuccess: done,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(url),
    onSuccess: done,
  });

  // Without a circuit the API needs the phases, so the default is not offered.
  const phasesRequired = defaultPhases == null;

  function submit(): void {
    setFieldError(null);
    if (kind === 'ac') {
      const amps = Number(current);
      if (
        current.trim() === '' ||
        !Number.isFinite(amps) ||
        amps < CURRENT_MIN_A ||
        amps > CURRENT_MAX_A ||
        !hasAtMostDecimals(amps, 1)
      ) {
        setFieldError(t('loadManagement.unitBudgetCurrentRange'));
        return;
      }
      if (phasesRequired && phases === '') {
        setFieldError(t('loadManagement.unitBudgetPhasesRequired'));
        return;
      }
      save.mutate({
        kind: 'ac',
        maxCurrentA: amps,
        ...(phases !== '' ? { phases: Number(phases) } : {}),
      });
      return;
    }
    const kw = Number(power);
    if (
      power.trim() === '' ||
      !Number.isFinite(kw) ||
      kw < POWER_MIN_KW ||
      kw > POWER_MAX_KW ||
      !hasAtMostDecimals(kw, 2)
    ) {
      setFieldError(t('loadManagement.unitBudgetPowerRange'));
      return;
    }
    save.mutate({ kind: 'dc', maxPowerKw: kw });
  }

  const serverError = save.error ?? remove.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          save.reset();
          remove.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md" scrollable>
        <DialogHeader>
          <DialogTitle>{t('loadManagement.unitBudgetTitle', { unit: unit.name })}</DialogTitle>
          <DialogDescription>{t('loadManagement.unitBudgetDescription')}</DialogDescription>
        </DialogHeader>
        <DialogForm
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="unit-budget-kind">{t('loadManagement.unitBudgetKind')}</Label>
              <Select
                id="unit-budget-kind"
                value={kind}
                disabled={fixedKind != null}
                onChange={(e) => {
                  setKind(e.target.value === 'dc' ? 'dc' : 'ac');
                  setFieldError(null);
                }}
              >
                <option value="ac">{t('loadManagement.unitBudgetKindAc')}</option>
                <option value="dc">{t('loadManagement.unitBudgetKindDc')}</option>
              </Select>
            </div>
            {kind === 'ac' ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="unit-budget-current">
                    {t('loadManagement.unitBudgetMaxCurrent')}
                  </Label>
                  <DecimalInput
                    id="unit-budget-current"
                    value={current}
                    onChange={setCurrent}
                    decimalScale={1}
                    aria-describedby="unit-budget-current-hint"
                  />
                  <p id="unit-budget-current-hint" className="text-xs text-muted-foreground">
                    {t('loadManagement.unitBudgetFuseHint')}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="unit-budget-phases">{t('loadManagement.unitBudgetPhases')}</Label>
                  <Select
                    id="unit-budget-phases"
                    value={phases}
                    onChange={(e) => {
                      setPhases(e.target.value);
                    }}
                  >
                    {phasesRequired ? (
                      <option value="">{t('loadManagement.unitBudgetPhasesPick')}</option>
                    ) : (
                      <option value="">
                        {t('loadManagement.unitBudgetPhasesDefault', { phases: defaultPhases })}
                      </option>
                    )}
                    <option value="1">{t('loadManagement.unitBudgetPhasesOne')}</option>
                    <option value="3">{t('loadManagement.unitBudgetPhasesThree')}</option>
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="unit-budget-power">{t('loadManagement.unitBudgetMaxPower')}</Label>
                <DecimalInput
                  id="unit-budget-power"
                  value={power}
                  onChange={setPower}
                  decimalScale={2}
                  aria-describedby="unit-budget-power-hint"
                />
                <p id="unit-budget-power-hint" className="text-xs text-muted-foreground">
                  {t('loadManagement.unitBudgetPowerHint')}
                </p>
              </div>
            )}
            {(fieldError != null || serverError != null) && (
              <p role="alert" className="text-sm text-destructive">
                {fieldError ?? getErrorMessage(serverError, t, 'loadManagement.saveFailed')}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            {unit.budget != null && (
              <div className="sm:mr-auto">
                <RemoveButton
                  label={t('loadManagement.unitBudgetRemove')}
                  disabled={remove.isPending || save.isPending}
                  onClick={() => {
                    remove.mutate();
                  }}
                />
              </div>
            )}
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <SaveButton isPending={save.isPending} disabled={save.isPending || remove.isPending} />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
