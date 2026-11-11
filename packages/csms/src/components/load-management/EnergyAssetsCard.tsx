// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CreateButton } from '@/components/create-button';
import { EditIconButton } from '@/components/edit-icon-button';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { formatNumber } from '@/lib/formatting';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { EnergyAssetForm } from './EnergyAssetForm';
import {
  flattenPanelNodes,
  supplyStateKey,
  supplyStateVariant,
  type EnergyAssetItem,
  type TransformerItem,
  type TreeNode,
} from './load-management-types';

interface EnergyAssetsCardProps {
  siteId: string;
  assets: EnergyAssetItem[];
  transformers: TransformerItem[];
  panels: TreeNode[];
  simulatedAllowed: boolean;
  canWrite: boolean;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

/** The ratings of an asset in one line: kWh or kWp, then the inverter output. */
function ratingText(asset: EnergyAssetItem): string {
  const parts: string[] = [];
  if (asset.type === 'battery' && asset.capacityKwh != null) {
    parts.push(`${formatNumber(asset.capacityKwh, 0)} kWh`);
  }
  if (asset.type === 'solar' && asset.peakKwp != null) {
    parts.push(`${formatNumber(asset.peakKwp, 0)} kWp`);
  }
  if (asset.inverterKw != null) parts.push(`${formatNumber(asset.inverterKw, 1)} kW`);
  return parts.length > 0 ? parts.join(', ') : '-';
}

/**
 * Batteries and solar arrays of the site: each with its connection point,
 * supply state (Live, Stale, No Data), last reading and the credit load
 * management gives it now. Read only without loadManagement:write.
 */
export function EnergyAssetsCard({
  siteId,
  assets,
  transformers,
  panels,
  simulatedAllowed,
  canWrite,
  isLoading,
  isError,
  onRetry,
}: EnergyAssetsCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EnergyAssetItem | undefined>(undefined);
  const [deleting, setDeleting] = useState<EnergyAssetItem | null>(null);

  const panelNames = new Map(flattenPanelNodes(panels).map((p) => [p.id, p.name]));
  const transformerNames = new Map(transformers.map((tx) => [tx.id, tx.name]));

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/sites/${siteId}/energy-assets/${id}`),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
  });

  function connectionText(asset: EnergyAssetItem): string {
    if (asset.connectionTransformerId != null) {
      return transformerNames.get(asset.connectionTransformerId) ?? t('common.unnamedTransformer');
    }
    if (asset.connectionPanelId != null) {
      return panelNames.get(asset.connectionPanelId) ?? t('common.unnamedPanel');
    }
    return t('loadManagement.connectionNoneShort');
  }

  // The dialogs sit outside the TabPanel: an empty panel renders its empty
  // message instead of its children, so the first asset could not be added.
  return (
    <>
      <TabPanel
        title={t('loadManagement.energyAssets')}
        description={t('loadManagement.energyAssetsHelp')}
        isLoading={isLoading}
        isError={isError}
        onRetry={onRetry}
        isEmpty={assets.length === 0}
        emptyMessage={t('loadManagement.noEnergyAssets')}
        actions={
          canWrite ? (
            <CreateButton
              label={t('loadManagement.addEnergyAsset')}
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            />
          ) : undefined
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('loadManagement.columns.name')}</TableHead>
                <TableHead>{t('loadManagement.columns.type')}</TableHead>
                <TableHead>{t('loadManagement.columns.rating')}</TableHead>
                <TableHead>{t('loadManagement.columns.connection')}</TableHead>
                <TableHead>{t('loadManagement.columns.supply')}</TableHead>
                <TableHead>{t('loadManagement.columns.lastReading')}</TableHead>
                <TableHead>{t('loadManagement.columns.credit')}</TableHead>
                {canWrite && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.map((asset) => (
                <TableRow key={asset.id} data-testid={`energy-asset-${asset.id}`}>
                  <TableCell className="font-medium">{asset.name}</TableCell>
                  <TableCell>
                    {asset.type === 'battery'
                      ? t('loadManagement.assetTypeBattery')
                      : t('loadManagement.assetTypeSolar')}
                  </TableCell>
                  <TableCell>{ratingText(asset)}</TableCell>
                  <TableCell>{connectionText(asset)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant={supplyStateVariant(asset.supply.state)}>
                        {t(supplyStateKey(asset.supply.state))}
                      </Badge>
                      {!asset.supply.counted ? (
                        <p className="text-xs text-muted-foreground">
                          {t('loadManagement.supplyNotConnected')}
                        </p>
                      ) : (
                        asset.supply.state !== 'fresh' && (
                          <p className="text-xs text-muted-foreground">
                            {t('loadManagement.supplyStaleBody')}
                          </p>
                        )
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    {asset.reading != null ? (
                      <div className="space-y-0.5">
                        <p>{formatDateTime(asset.reading.receivedAt, timezone)}</p>
                        <p className="text-xs text-muted-foreground">
                          {formatNumber(asset.reading.powerKw, 1)} kW
                          {asset.reading.socPercent != null &&
                            `, ${t('loadManagement.stateOfChargeValue', {
                              percent: formatNumber(asset.reading.socPercent, 0),
                            })}`}
                        </p>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{t('loadManagement.noReading')}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="space-y-0.5">
                      <p>{formatNumber(asset.supply.creditKw, 1)} kW</p>
                      {asset.supply.loadKw > 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t('loadManagement.assetLoadValue', {
                            kw: formatNumber(asset.supply.loadKw, 1),
                          })}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <EditIconButton
                          title={t('loadManagement.editEnergyAssetNamed', { name: asset.name })}
                          onClick={() => {
                            setEditing(asset);
                            setFormOpen(true);
                          }}
                        />
                        <RemoveIconButton
                          title={t('loadManagement.deleteEnergyAssetNamed', { name: asset.name })}
                          onClick={() => {
                            deleteMutation.reset();
                            setDeleting(asset);
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
      </TabPanel>

      {canWrite && (
        <>
          <EnergyAssetForm
            siteId={siteId}
            asset={editing}
            transformers={transformers}
            panels={panels}
            simulatedAllowed={simulatedAllowed}
            open={formOpen}
            onClose={() => {
              setFormOpen(false);
            }}
            onSaved={refresh}
          />
          <ConfirmDialog
            open={deleting != null}
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            title={t('loadManagement.deleteEnergyAsset')}
            description={t('loadManagement.confirmDeleteEnergyAsset')}
            confirmLabel={t('common.delete')}
            onConfirm={() => {
              if (deleting != null) deleteMutation.mutate(deleting.id);
              return false;
            }}
            isPending={deleteMutation.isPending}
          >
            {deleteMutation.isError && (
              <p className="text-sm text-destructive">
                {getErrorMessage(deleteMutation.error, t, 'loadManagement.saveFailed')}
              </p>
            )}
          </ConfirmDialog>
        </>
      )}
    </>
  );
}
