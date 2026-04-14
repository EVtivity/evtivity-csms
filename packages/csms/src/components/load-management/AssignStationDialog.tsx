// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Zap } from 'lucide-react';
import { api } from '@/lib/api';

interface StationStatus {
  id: string;
  stationId: string;
  currentDrawKw: number;
  allocatedLimitKw: number | null;
  maxPowerKw: number;
  loadPriority: number;
  isOnline: boolean;
  hasActiveSession: boolean;
}

interface AssignStationDialogProps {
  siteId: string;
  circuitId: string;
  stations: StationStatus[];
  assignedStationIds: string[];
  open: boolean;
  onClose: () => void;
  onAssigned: () => void;
}

export function AssignStationDialog({
  siteId,
  circuitId,
  stations,
  assignedStationIds,
  open,
  onClose,
  onAssigned,
}: AssignStationDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const assignedSet = new Set(assignedStationIds);
  const availableStations = stations.filter((s) => !assignedSet.has(s.id));

  const mutation = useMutation({
    mutationFn: (stationId: string) =>
      api.patch(`/v1/sites/${siteId}/stations/${stationId}/circuit`, { circuitId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId, 'load-management'] });
      onAssigned();
      onClose();
      setSelectedId(null);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('loadManagement.assignStation')}</DialogTitle>
        </DialogHeader>

        {availableStations.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t('loadManagement.noAvailableStations')}
          </p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {availableStations.map((station) => (
              <button
                key={station.id}
                type="button"
                onClick={() => {
                  setSelectedId(station.id);
                }}
                className={`w-full flex items-center gap-2 p-2 rounded-md text-sm transition-colors ${
                  selectedId === station.id
                    ? 'bg-primary/10 border border-primary'
                    : 'hover:bg-muted border border-transparent'
                }`}
              >
                <Zap className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{station.stationId}</span>
                <Badge
                  variant={station.isOnline ? 'success' : 'outline'}
                  className="text-xs ml-auto"
                >
                  {station.isOnline ? 'Online' : 'Offline'}
                </Badge>
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={selectedId == null || mutation.isPending}
            onClick={() => {
              if (selectedId != null) mutation.mutate(selectedId);
            }}
          >
            {mutation.isPending ? t('common.loading') : t('loadManagement.assignStation')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
