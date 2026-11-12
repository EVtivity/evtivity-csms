// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import type { StationUnit } from '@/lib/station-units';

/** The longest unit name the API stores (after trimming). */
const UNIT_NAME_MAX = 50;

/** A unit being added (`id` null) or renamed. */
export interface UnitNameDraft {
  id: string | null;
  name: string;
}

interface UnitEvse {
  evseId: number;
  unitId?: string | null;
}

/** Reloads the units, the EVSEs and the station lists after a unit change. */
function useUnitRefresh(stationId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'units'] });
    void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'connectors'] });
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
  };
}

function useUnitError(): (err: unknown) => void {
  const { t } = useTranslation();
  const { toast } = useToast();
  return (err: unknown) => {
    toast({ variant: 'destructive', title: getErrorMessage(err, t) });
  };
}

/** Sets the unit of one EVSE (`PUT /v1/stations/:id/evses/:evseId/unit`). */
function useAssignEvseUnit(stationId: string, onDone?: () => void) {
  const refresh = useUnitRefresh(stationId);
  const onError = useUnitError();
  return useMutation({
    mutationFn: ({ evseId, unitId }: { evseId: number; unitId: string | null }) =>
      api.put(`/v1/stations/${stationId}/evses/${String(evseId)}/unit`, { unitId }),
    onSuccess: () => {
      onDone?.();
      refresh();
    },
    onError,
  });
}

/** The Add Unit and Rename Unit dialog. Open while `draft` is set. */
export function StationUnitNameDialog({
  stationId,
  draft,
  onDraftChange,
}: {
  stationId: string;
  draft: UnitNameDraft | null;
  onDraftChange: (draft: UnitNameDraft | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const refresh = useUnitRefresh(stationId);
  const onError = useUnitError();
  const save = useMutation({
    mutationFn: (value: UnitNameDraft) =>
      value.id == null
        ? api.post(`/v1/stations/${stationId}/units`, { name: value.name })
        : api.patch(`/v1/stations/${stationId}/units/${value.id}`, { name: value.name }),
    onSuccess: () => {
      onDraftChange(null);
      refresh();
    },
    onError,
  });
  return (
    <Dialog
      open={draft != null}
      onOpenChange={(open) => {
        if (!open) onDraftChange(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {draft?.id == null ? t('stationUnits.addUnit') : t('stationUnits.renameUnit')}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft != null) save.mutate(draft);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="station-unit-name">{t('stationUnits.unitName')}</Label>
            <Input
              id="station-unit-name"
              required
              maxLength={UNIT_NAME_MAX}
              value={draft?.name ?? ''}
              onChange={(e) => {
                if (draft != null) onDraftChange({ ...draft, name: e.target.value });
              }}
            />
          </div>
          <DialogFooter>
            <CancelButton
              onClick={() => {
                onDraftChange(null);
              }}
            />
            <SaveButton isPending={save.isPending} disabled={(draft?.name.trim() ?? '') === ''} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The Delete Unit confirmation. Open while `unit` is set. */
export function StationUnitDeleteDialog({
  stationId,
  unit,
  onClose,
}: {
  stationId: string;
  unit: StationUnit | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const refresh = useUnitRefresh(stationId);
  const onError = useUnitError();
  const remove = useMutation({
    mutationFn: (unitId: string) => api.delete(`/v1/stations/${stationId}/units/${unitId}`),
    onSuccess: () => {
      onClose();
      refresh();
    },
    onError,
  });
  return (
    <ConfirmDialog
      open={unit != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('stationUnits.deleteUnit')}
      description={t('stationUnits.deleteConfirm', { name: unit?.name ?? '' })}
      confirmLabel={t('stationUnits.deleteUnit')}
      variant="destructive"
      isPending={remove.isPending}
      onConfirm={() => {
        if (unit != null) remove.mutate(unit.id);
      }}
    />
  );
}

/**
 * The EVSEs a unit's Assign EVSE picker offers: every EVSE not in the unit,
 * the EVSEs without a unit first, then the EVSEs of the other units in the
 * station's unit order, each in EVSE number order.
 */
export function assignableEvses<E extends UnitEvse>(
  evses: readonly E[],
  units: readonly StationUnit[],
  unitId: string,
): E[] {
  const order = new Map(
    [...units]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((u, i) => [u.id, i]),
  );
  const rank = (e: E): number =>
    e.unitId == null || !order.has(e.unitId) ? -1 : (order.get(e.unitId) ?? 0);
  return evses
    .filter((e) => e.unitId !== unitId)
    .sort((a, b) => rank(a) - rank(b) || a.evseId - b.evseId);
}

/**
 * The Assign EVSE dialog of a unit card: picks an EVSE that is not in the
 * unit and moves it there. An EVSE of another unit leaves that unit, since an
 * EVSE belongs to one unit only. Open while `unit` is set.
 */
export function StationUnitAssignDialog({
  stationId,
  unit,
  units,
  evses,
  onClose,
}: {
  stationId: string;
  unit: StationUnit | null;
  units: StationUnit[];
  evses: UnitEvse[];
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [evseId, setEvseId] = useState('');
  const close = (): void => {
    setEvseId('');
    onClose();
  };
  const assign = useAssignEvseUnit(stationId, close);
  const options = unit == null ? [] : assignableEvses(evses, units, unit.id);
  const unitName = (id: string | null | undefined): string =>
    units.find((u) => u.id === id)?.name ?? t('stationUnits.noUnit');
  return (
    <Dialog
      open={unit != null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('stationUnits.assignEvse')}</DialogTitle>
          <DialogDescription>
            {t('stationUnits.assignEvseDescription', { name: unit?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (unit != null && evseId !== '') {
              assign.mutate({ evseId: Number(evseId), unitId: unit.id });
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="station-unit-assign-evse">{t('stationUnits.evse')}</Label>
            <Select
              id="station-unit-assign-evse"
              required
              value={evseId}
              onChange={(e) => {
                setEvseId(e.target.value);
              }}
            >
              <option value="" disabled>
                {t('stationUnits.chooseEvse')}
              </option>
              {options.map((evse) => (
                <option key={evse.evseId} value={String(evse.evseId)}>
                  {t('stationUnits.evseInUnit', {
                    evse: t('charts.evse', { id: evse.evseId }),
                    unit: unitName(evse.unitId),
                  })}
                </option>
              ))}
            </Select>
          </div>
          <DialogFooter>
            <CancelButton onClick={close} />
            <SaveButton isPending={assign.isPending} disabled={evseId === ''} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The Unit picker of an EVSE card: its unit, or none. Read-only text without
 * `stations:write`.
 */
export function StationEvseUnitPicker({
  stationId,
  evse,
  units,
}: {
  stationId: string;
  evse: UnitEvse;
  units: StationUnit[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const canWrite = useHasPermission('stations:write');
  const assign = useAssignEvseUnit(stationId);
  const id = `evse-unit-${String(evse.evseId)}`;
  const label = t('stationUnits.unitOfEvse', { evse: t('charts.evse', { id: evse.evseId }) });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor={id} className="text-sm text-muted-foreground">
        {t('stationUnits.unit')}
      </Label>
      {canWrite ? (
        <Select
          id={id}
          aria-label={label}
          className="w-auto min-w-40"
          value={evse.unitId ?? ''}
          disabled={assign.isPending}
          onChange={(e) => {
            assign.mutate({
              evseId: evse.evseId,
              unitId: e.target.value === '' ? null : e.target.value,
            });
          }}
        >
          <option value="">{t('stationUnits.noUnit')}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      ) : (
        <span id={id} className="text-sm">
          {units.find((u) => u.id === evse.unitId)?.name ?? t('stationUnits.noUnit')}
        </span>
      )}
    </div>
  );
}
