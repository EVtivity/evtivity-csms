// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Pause, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useTranslation } from 'react-i18next';
import { AddIconButton } from '@/components/add-icon-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { connectorStatusVariant } from '@/lib/status-variants';

const CONNECTOR_TYPES = ['CCS2', 'CHAdeMO', 'Type2', 'Type1', 'GBT', 'Tesla', 'NACS'] as const;

interface Connector {
  connectorId: number;
  connectorType: string | null;
  maxPowerKw: number | null;
  maxCurrentAmps: number | null;
  status: string;
  autoCreated?: boolean;
  isIdling?: boolean;
}

interface Evse {
  evseId: number;
  status: string;
  autoCreated?: boolean;
  connectors: Connector[];
}

interface ConnectorStatusProps {
  data: Evse[];
  stationId: string;
}

function statusClassName(status: string, isIdling?: boolean): string | undefined {
  if (status === 'occupied' && isIdling === true) return undefined;
  switch (status) {
    case 'available':
      return 'bg-green-500 text-green-50 hover:bg-green-500/80';
    case 'finishing':
      return 'bg-violet-500 text-violet-50 hover:bg-violet-500/80';
    case 'occupied':
    case 'charging':
    case 'discharging':
      return 'bg-blue-500 text-blue-50 hover:bg-blue-500/80';
    case 'preparing':
    case 'ev_connected':
      return 'bg-cyan-500 text-cyan-50 hover:bg-cyan-500/80';
    case 'reserved':
      return 'bg-orange-500 text-orange-50 hover:bg-orange-500/80';
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return 'bg-yellow-500 text-yellow-50 hover:bg-yellow-500/80';
    case 'faulted':
      return 'bg-red-500 text-red-50 hover:bg-red-500/80';
    default:
      return 'bg-red-500 text-red-50 hover:bg-red-500/80';
  }
}

interface ConnectorFormRow {
  connectorId: string;
  connectorType: string;
  maxPowerKw: string;
  maxCurrentAmps: string;
}

export function ConnectorStatus({ data, stationId }: ConnectorStatusProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Add EVSE dialog
  const [addEvseOpen, setAddEvseOpen] = useState(false);
  const [newEvseId, setNewEvseId] = useState('');
  const [newEvseConnector, setNewEvseConnector] = useState<ConnectorFormRow>({
    connectorId: '1',
    connectorType: 'CCS2',
    maxPowerKw: '',
    maxCurrentAmps: '',
  });

  // Add Connector dialog
  const [addConnectorOpen, setAddConnectorOpen] = useState(false);
  const [addConnectorEvseId, setAddConnectorEvseId] = useState(0);
  const [newConnector, setNewConnector] = useState<ConnectorFormRow>({
    connectorId: '',
    connectorType: 'CCS2',
    maxPowerKw: '',
    maxCurrentAmps: '',
  });

  // Edit EVSE dialog
  const [editEvseOpen, setEditEvseOpen] = useState(false);
  const [editEvseId, setEditEvseId] = useState(0);
  const [editConnectors, setEditConnectors] = useState<ConnectorFormRow[]>([]);

  // Delete confirmations
  const [deleteEvseOpen, setDeleteEvseOpen] = useState(false);
  const [deleteEvseId, setDeleteEvseId] = useState(0);
  const [deleteConnectorOpen, setDeleteConnectorOpen] = useState(false);
  const [deleteConnectorTarget, setDeleteConnectorTarget] = useState({ evseId: 0, connectorId: 0 });

  const invalidateConnectors = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId, 'connectors'] });
    },
  };

  const createEvseMutation = useMutation({
    mutationFn: (body: {
      evseId: number;
      connectors: {
        connectorId: number;
        connectorType: string;
        maxPowerKw: number;
        maxCurrentAmps?: number;
      }[];
    }) => api.post(`/v1/stations/${stationId}/evses`, body),
    ...invalidateConnectors,
  });

  const updateEvseMutation = useMutation({
    mutationFn: ({
      evseId,
      connectors,
    }: {
      evseId: number;
      connectors: {
        connectorId: number;
        connectorType?: string;
        maxPowerKw?: number;
        maxCurrentAmps?: number;
      }[];
    }) => api.patch(`/v1/stations/${stationId}/evses/${String(evseId)}`, { connectors }),
    ...invalidateConnectors,
  });

  const addConnectorMutation = useMutation({
    mutationFn: ({
      evseId,
      ...body
    }: {
      evseId: number;
      connectorId: number;
      connectorType: string;
      maxPowerKw: number;
      maxCurrentAmps?: number;
    }) => api.post(`/v1/stations/${stationId}/evses/${String(evseId)}/connectors`, body),
    ...invalidateConnectors,
  });

  const deleteEvseMutation = useMutation({
    mutationFn: (evseId: number) => api.delete(`/v1/stations/${stationId}/evses/${String(evseId)}`),
    ...invalidateConnectors,
  });

  const deleteConnectorMutation = useMutation({
    mutationFn: ({ evseId, connectorId }: { evseId: number; connectorId: number }) =>
      api.delete(
        `/v1/stations/${stationId}/evses/${String(evseId)}/connectors/${String(connectorId)}`,
      ),
    ...invalidateConnectors,
  });

  function handleAddEvse(e: React.SyntheticEvent): void {
    e.preventDefault();
    createEvseMutation.mutate(
      {
        evseId: Number(newEvseId),
        connectors: [
          {
            connectorId: Number(newEvseConnector.connectorId),
            connectorType: newEvseConnector.connectorType,
            maxPowerKw: Number(newEvseConnector.maxPowerKw),
            ...(newEvseConnector.maxCurrentAmps
              ? { maxCurrentAmps: Number(newEvseConnector.maxCurrentAmps) }
              : {}),
          },
        ],
      },
      {
        onSuccess: () => {
          setAddEvseOpen(false);
          setNewEvseId('');
          setNewEvseConnector({
            connectorId: '1',
            connectorType: 'CCS2',
            maxPowerKw: '',
            maxCurrentAmps: '',
          });
        },
      },
    );
  }

  function handleAddConnector(e: React.SyntheticEvent): void {
    e.preventDefault();
    addConnectorMutation.mutate(
      {
        evseId: addConnectorEvseId,
        connectorId: Number(newConnector.connectorId),
        connectorType: newConnector.connectorType,
        maxPowerKw: Number(newConnector.maxPowerKw),
        ...(newConnector.maxCurrentAmps
          ? { maxCurrentAmps: Number(newConnector.maxCurrentAmps) }
          : {}),
      },
      {
        onSuccess: () => {
          setAddConnectorOpen(false);
          setNewConnector({
            connectorId: '',
            connectorType: 'CCS2',
            maxPowerKw: '',
            maxCurrentAmps: '',
          });
        },
      },
    );
  }

  function handleEditEvse(e: React.SyntheticEvent): void {
    e.preventDefault();
    updateEvseMutation.mutate(
      {
        evseId: editEvseId,
        connectors: editConnectors.map((c) => ({
          connectorId: Number(c.connectorId),
          connectorType: c.connectorType,
          maxPowerKw: Number(c.maxPowerKw),
          ...(c.maxCurrentAmps ? { maxCurrentAmps: Number(c.maxCurrentAmps) } : {}),
        })),
      },
      {
        onSuccess: () => {
          setEditEvseOpen(false);
        },
      },
    );
  }

  function openEditEvse(evse: Evse): void {
    setEditEvseId(evse.evseId);
    setEditConnectors(
      evse.connectors.map((c) => ({
        connectorId: String(c.connectorId),
        connectorType: c.connectorType ?? 'CCS2',
        maxPowerKw: String(c.maxPowerKw ?? ''),
        maxCurrentAmps: String(c.maxCurrentAmps ?? ''),
      })),
    );
    setEditEvseOpen(true);
  }

  function openAddConnector(evseId: number): void {
    setAddConnectorEvseId(evseId);
    setNewConnector({ connectorId: '', connectorType: 'CCS2', maxPowerKw: '', maxCurrentAmps: '' });
    setAddConnectorOpen(true);
  }

  const IN_USE_STATUSES = [
    'occupied',
    'charging',
    'preparing',
    'ev_connected',
    'suspended_ev',
    'suspended_evse',
    'idle',
    'discharging',
  ];

  function hasInUseConnector(evse: Evse): boolean {
    return evse.connectors.some((c) => IN_USE_STATUSES.includes(c.status));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('charts.connectors')}</CardTitle>
        <CreateButton
          label={t('stations.addEvse')}
          onClick={() => {
            setAddEvseOpen(true);
          }}
        />
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('charts.noEvsesConfigured')}</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.map((evse) => (
              <div key={evse.evseId} className="rounded-lg border p-4 space-y-3">
                <div className="flex items-center justify-between pb-3 border-b">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {t('charts.evse', { id: evse.evseId })}
                    </span>
                    {evse.autoCreated === true && (
                      <Badge variant="outline" className="text-xs font-normal">
                        {t('stations.autoCreated')}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <AddIconButton
                      onClick={() => {
                        openAddConnector(evse.evseId);
                      }}
                      title={t('stations.addConnector')}
                    />
                    <EditIconButton
                      onClick={() => {
                        openEditEvse(evse);
                      }}
                      title={t('stations.editEvse')}
                    />
                    <RemoveIconButton
                      disabled={hasInUseConnector(evse)}
                      onClick={() => {
                        setDeleteEvseId(evse.evseId);
                        setDeleteEvseOpen(true);
                      }}
                      title={
                        hasInUseConnector(evse)
                          ? t('stations.cannotDeleteOccupied')
                          : t('stations.deleteEvse')
                      }
                    />
                  </div>
                </div>
                {evse.connectors.length > 0 ? (
                  <div className="space-y-2">
                    {evse.connectors.map((conn) => (
                      <div
                        key={conn.connectorId}
                        className="flex items-center justify-between text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            {t('charts.connector', { id: conn.connectorId })}
                          </span>
                          {conn.connectorType != null && (
                            <span className="text-muted-foreground">({conn.connectorType})</span>
                          )}
                          {conn.autoCreated === true && (
                            <Badge variant="outline" className="text-xs font-normal">
                              {t('stations.autoCreated')}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {conn.maxPowerKw != null && (
                            <span className="text-muted-foreground">
                              {t('charts.powerValue', { value: conn.maxPowerKw })}
                            </span>
                          )}
                          {conn.maxCurrentAmps != null && (
                            <span className="text-muted-foreground">
                              {t('charts.currentValue', { value: conn.maxCurrentAmps })}
                            </span>
                          )}
                          <Badge
                            variant={connectorStatusVariant(conn.status, conn.isIdling)}
                            className={statusClassName(conn.status, conn.isIdling)}
                          >
                            {conn.isIdling === true && <Pause className="h-3 w-3" />}
                            {conn.isIdling === true
                              ? t('status.idle')
                              : t(`status.${conn.status}` as 'status.available', conn.status)}
                          </Badge>
                          {!IN_USE_STATUSES.includes(conn.status) && (
                            <RemoveIconButton
                              size="sm"
                              onClick={() => {
                                setDeleteConnectorTarget({
                                  evseId: evse.evseId,
                                  connectorId: conn.connectorId,
                                });
                                setDeleteConnectorOpen(true);
                              }}
                              title={t('stations.deleteConnector')}
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t('charts.noConnectors')}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Add EVSE Dialog */}
      <Dialog open={addEvseOpen} onOpenChange={setAddEvseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stations.addEvse')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddEvse} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-evse-id">{t('stations.evseIdLabel')}</Label>
              <Input
                id="new-evse-id"
                type="number"
                min="1"
                required
                value={newEvseId}
                onChange={(e) => {
                  setNewEvseId(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-evse-conn-id">{t('stations.connectorIdLabel')}</Label>
              <Input
                id="new-evse-conn-id"
                type="number"
                min="1"
                required
                value={newEvseConnector.connectorId}
                onChange={(e) => {
                  setNewEvseConnector((prev) => ({ ...prev, connectorId: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-evse-conn-type">{t('stations.connectorType')}</Label>
              <Select
                id="new-evse-conn-type"
                value={newEvseConnector.connectorType}
                onChange={(e) => {
                  setNewEvseConnector((prev) => ({ ...prev, connectorType: e.target.value }));
                }}
                className="h-9"
              >
                {CONNECTOR_TYPES.map((ct) => (
                  <option key={ct} value={ct}>
                    {ct}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-evse-conn-power">{t('stations.maxPower')}</Label>
              <Input
                id="new-evse-conn-power"
                type="number"
                min="1"
                required
                value={newEvseConnector.maxPowerKw}
                onChange={(e) => {
                  setNewEvseConnector((prev) => ({ ...prev, maxPowerKw: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-evse-conn-current">{t('stations.maxCurrent')}</Label>
              <Input
                id="new-evse-conn-current"
                type="number"
                min="1"
                value={newEvseConnector.maxCurrentAmps}
                onChange={(e) => {
                  setNewEvseConnector((prev) => ({ ...prev, maxCurrentAmps: e.target.value }));
                }}
              />
            </div>
            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setAddEvseOpen(false);
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createEvseMutation.isPending}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Connector Dialog */}
      <Dialog open={addConnectorOpen} onOpenChange={setAddConnectorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('stations.addConnector')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddConnector} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-conn-id">{t('stations.connectorIdLabel')}</Label>
              <Input
                id="add-conn-id"
                type="number"
                min="1"
                required
                value={newConnector.connectorId}
                onChange={(e) => {
                  setNewConnector((prev) => ({ ...prev, connectorId: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-conn-type">{t('stations.connectorType')}</Label>
              <Select
                id="add-conn-type"
                value={newConnector.connectorType}
                onChange={(e) => {
                  setNewConnector((prev) => ({ ...prev, connectorType: e.target.value }));
                }}
                className="h-9"
              >
                {CONNECTOR_TYPES.map((ct) => (
                  <option key={ct} value={ct}>
                    {ct}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-conn-power">{t('stations.maxPower')}</Label>
              <Input
                id="add-conn-power"
                type="number"
                min="1"
                required
                value={newConnector.maxPowerKw}
                onChange={(e) => {
                  setNewConnector((prev) => ({ ...prev, maxPowerKw: e.target.value }));
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-conn-current">{t('stations.maxCurrent')}</Label>
              <Input
                id="add-conn-current"
                type="number"
                min="1"
                value={newConnector.maxCurrentAmps}
                onChange={(e) => {
                  setNewConnector((prev) => ({ ...prev, maxCurrentAmps: e.target.value }));
                }}
              />
            </div>
            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setAddConnectorOpen(false);
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={addConnectorMutation.isPending}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit EVSE Dialog */}
      <Dialog open={editEvseOpen} onOpenChange={setEditEvseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('stations.editEvse')} - {t('charts.evse', { id: editEvseId })}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleEditEvse} className="space-y-4">
            {editConnectors.map((c, i) => (
              <div key={c.connectorId} className="rounded-lg border p-3 space-y-2">
                <p className="text-sm font-medium">
                  {t('charts.connector', { id: c.connectorId })}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`edit-type-${String(i)}`}>{t('stations.connectorType')}</Label>
                    <Select
                      id={`edit-type-${String(i)}`}
                      value={c.connectorType}
                      onChange={(e) => {
                        const idx = i;
                        setEditConnectors((prev) =>
                          prev.map((item, j) =>
                            j === idx ? { ...item, connectorType: e.target.value } : item,
                          ),
                        );
                      }}
                      className="h-9"
                    >
                      {CONNECTOR_TYPES.map((ct) => (
                        <option key={ct} value={ct}>
                          {ct}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`edit-power-${String(i)}`}>{t('stations.maxPower')}</Label>
                    <Input
                      id={`edit-power-${String(i)}`}
                      type="number"
                      min="1"
                      required
                      value={c.maxPowerKw}
                      onChange={(e) => {
                        const idx = i;
                        setEditConnectors((prev) =>
                          prev.map((item, j) =>
                            j === idx ? { ...item, maxPowerKw: e.target.value } : item,
                          ),
                        );
                      }}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`edit-current-${String(i)}`}>{t('stations.maxCurrent')}</Label>
                    <Input
                      id={`edit-current-${String(i)}`}
                      type="number"
                      min="1"
                      value={c.maxCurrentAmps}
                      onChange={(e) => {
                        const idx = i;
                        setEditConnectors((prev) =>
                          prev.map((item, j) =>
                            j === idx ? { ...item, maxCurrentAmps: e.target.value } : item,
                          ),
                        );
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
            <DialogFooter>
              <CancelButton
                onClick={() => {
                  setEditEvseOpen(false);
                }}
              />
              <SaveButton isPending={updateEvseMutation.isPending} />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete EVSE Confirmation */}
      <ConfirmDialog
        open={deleteEvseOpen}
        onOpenChange={setDeleteEvseOpen}
        title={t('stations.deleteEvse')}
        description={t('stations.confirmDeleteEvse', { id: deleteEvseId })}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          deleteEvseMutation.mutate(deleteEvseId);
        }}
      />

      {/* Delete Connector Confirmation */}
      <ConfirmDialog
        open={deleteConnectorOpen}
        onOpenChange={setDeleteConnectorOpen}
        title={t('stations.deleteConnector')}
        description={t('stations.confirmDeleteConnector', {
          id: deleteConnectorTarget.connectorId,
        })}
        confirmLabel={t('common.delete')}
        confirmIcon={<Trash2 className="h-4 w-4" />}
        onConfirm={() => {
          deleteConnectorMutation.mutate(deleteConnectorTarget);
        }}
      />
    </Card>
  );
}
