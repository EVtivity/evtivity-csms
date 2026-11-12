// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/ui/content-state';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CreateButton } from '@/components/create-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import type { StationUnit } from '@/lib/station-units';
import { STATION_UNITS_CARD_ID } from './StationUnassignedEvsesNotice';

/** The longest unit name the API stores (after trimming). */
const UNIT_NAME_MAX = 50;

interface UnitsCardEvse {
  evseId: number;
  unitId?: string | null;
}

/**
 * The units (physical charger boxes, a master and its extenders) of a station
 * on its Connectors tab: add, rename and delete units and move each EVSE into
 * a unit. Read-only without `stations:write`. A station without units shows
 * only the Add Unit action, so its tab reads as before.
 */
export function StationUnitsCard({
  stationId,
  units,
  evses,
}: {
  stationId: string;
  units: StationUnit[] | undefined;
  evses: UnitsCardEvse[] | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('stations:write');
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [deleting, setDeleting] = useState<StationUnit | null>(null);
  const list = units ?? [];

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'units'] });
    void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'connectors'] });
    void queryClient.invalidateQueries({ queryKey: ['stations'] });
  }

  const onError = (err: unknown): void => {
    toast({ variant: 'destructive', title: getErrorMessage(err, t) });
  };

  const save = useMutation({
    mutationFn: (value: { id: string | null; name: string }) =>
      value.id == null
        ? api.post(`/v1/stations/${stationId}/units`, { name: value.name })
        : api.patch(`/v1/stations/${stationId}/units/${value.id}`, { name: value.name }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: (unitId: string) => api.delete(`/v1/stations/${stationId}/units/${unitId}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
    onError,
  });

  const assign = useMutation({
    mutationFn: ({ evseId, unitId }: { evseId: number; unitId: string | null }) =>
      api.put(`/v1/stations/${stationId}/evses/${String(evseId)}/unit`, { unitId }),
    onSuccess: refresh,
    onError,
  });

  const nameOf = (unitId: string | null | undefined): string =>
    list.find((u) => u.id === unitId)?.name ?? t('stationUnits.noUnit');

  return (
    <div id={STATION_UNITS_CARD_ID} className="scroll-mt-4">
      <TabPanel
        title={t('stationUnits.title')}
        description={t('stationUnits.description')}
        actions={
          canWrite ? (
            <CreateButton
              label={t('stationUnits.addUnit')}
              onClick={() => {
                save.reset();
                setEditing({ id: null, name: '' });
              }}
            />
          ) : undefined
        }
      >
        {list.length === 0 ? (
          <EmptyState>{t('stationUnits.empty')}</EmptyState>
        ) : (
          <div className="space-y-6">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('stationUnits.unitName')}</TableHead>
                    <TableHead>{t('stationUnits.evses')}</TableHead>
                    {canWrite && <TableHead className="w-24" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((unit) => (
                    <TableRow key={unit.id} data-testid={`station-unit-row-${unit.id}`}>
                      <TableCell className="font-medium">{unit.name}</TableCell>
                      <TableCell>
                        {unit.evseNumbers.length === 0
                          ? t('stationUnits.noEvses')
                          : unit.evseNumbers.map((n) => t('charts.evse', { id: n })).join(', ')}
                      </TableCell>
                      {canWrite && (
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <EditIconButton
                              title={t('stationUnits.renameUnit')}
                              onClick={() => {
                                save.reset();
                                setEditing({ id: unit.id, name: unit.name });
                              }}
                            />
                            <RemoveIconButton
                              title={t('stationUnits.deleteUnit')}
                              onClick={() => {
                                setDeleting(unit);
                              }}
                            />
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t('stationUnits.assignTitle')}</h3>
              <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {(evses ?? []).map((evse) => (
                  <div key={evse.evseId} className="space-y-1">
                    <Label htmlFor={`evse-unit-${String(evse.evseId)}`}>
                      {t('charts.evse', { id: evse.evseId })}
                    </Label>
                    {canWrite ? (
                      <Select
                        id={`evse-unit-${String(evse.evseId)}`}
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
                        {list.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <p id={`evse-unit-${String(evse.evseId)}`} className="text-sm">
                        {nameOf(evse.unitId)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <Dialog
          open={editing != null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editing?.id == null ? t('stationUnits.addUnit') : t('stationUnits.renameUnit')}
              </DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (editing != null) save.mutate(editing);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="station-unit-name">{t('stationUnits.unitName')}</Label>
                <Input
                  id="station-unit-name"
                  required
                  maxLength={UNIT_NAME_MAX}
                  value={editing?.name ?? ''}
                  onChange={(e) => {
                    const name = e.target.value;
                    setEditing((prev) => (prev == null ? prev : { ...prev, name }));
                  }}
                />
              </div>
              <DialogFooter>
                <CancelButton
                  onClick={() => {
                    setEditing(null);
                  }}
                />
                <SaveButton
                  isPending={save.isPending}
                  disabled={(editing?.name.trim() ?? '') === ''}
                />
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleting != null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title={t('stationUnits.deleteUnit')}
          description={t('stationUnits.deleteConfirm', { name: deleting?.name ?? '' })}
          confirmLabel={t('stationUnits.deleteUnit')}
          variant="destructive"
          isPending={remove.isPending}
          onConfirm={() => {
            if (deleting != null) remove.mutate(deleting.id);
          }}
        />
      </TabPanel>
    </div>
  );
}
