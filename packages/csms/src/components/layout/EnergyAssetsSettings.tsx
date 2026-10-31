// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The batteries and solar canopies of Edit Layout (Site Settings panel):
// information only, nothing in the CSMS reads storage or solar data. A
// battery stands on the grass like a transformer (drag it in 3D); a solar
// carport canopy covers one row of a parking lot (an office or retail site
// keeps its canopies stored but hidden).

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  LAYOUT_GRID_LIMITS,
  energyAssetsOf,
  lotExtentM,
  placeEnergyAsset,
  showsSolar,
  TRANSFORMER_CLEARANCE_M,
  type LayoutEnergyAsset,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';

const L = LAYOUT_GRID_LIMITS;

/** A typed capacity (kWh or kWp): null when empty, undefined when invalid. */
export function parseCapacity(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < L.capacity.min || value > L.capacity.max)
    return undefined;
  return value;
}

function nextId(assets: readonly LayoutEnergyAsset[], prefix: string): string {
  const ids = new Set(assets.map((a) => a.id));
  let n = 1;
  while (ids.has(`${prefix}-${String(n)}`)) n++;
  return `${prefix}-${String(n)}`;
}

/** A new battery: on the grass behind the lot, right of the transformers. */
export function newBattery(settings: SiteLayoutSettings): LayoutEnergyAsset {
  const assets = energyAssetsOf(settings);
  const batteries = assets.filter((a) => a.type === 'battery').length;
  const width = lotExtentM(settings).width;
  return placeEnergyAsset(
    {
      id: nextId(assets, 'bat'),
      type: 'battery',
      name: null,
      capacityKwh: null,
      x: Math.min(width, 6 + 5 * batteries),
      z: -TRANSFORMER_CLEARANCE_M - 1.5,
    },
    settings,
  );
}

/** A new solar canopy over the first row without one (else the last row). */
export function newSolarCanopy(settings: SiteLayoutSettings): LayoutEnergyAsset {
  const assets = energyAssetsOf(settings);
  const covered = new Set(assets.flatMap((a) => (a.type === 'solar' ? [a.row] : [])));
  let row = 0;
  while (covered.has(row) && row < settings.rows - 1) row++;
  return { id: nextId(assets, 'pv'), type: 'solar', name: null, capacityKwp: null, row };
}

interface EnergyAssetsSettingsProps {
  settings: SiteLayoutSettings;
  onChange: (settings: SiteLayoutSettings) => void;
  /** True while a typed capacity is invalid (Save waits for it). */
  onInvalidChange: (invalid: boolean) => void;
}

export function EnergyAssetsSettings({
  settings,
  onChange,
  onInvalidChange,
}: EnergyAssetsSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const assets = energyAssetsOf(settings);
  const solarShown = showsSolar(settings);
  const id = (name: string): string => `layout-energy-${name}`;

  function setAssets(next: LayoutEnergyAsset[]): void {
    onChange({ ...settings, energyAssets: next });
  }

  function update(assetId: string, patch: Partial<LayoutEnergyAsset>): void {
    setAssets(
      assets.map((a) => (a.id === assetId ? ({ ...a, ...patch } as LayoutEnergyAsset) : a)),
    );
  }

  function setDraft(next: Record<string, string>): void {
    setDrafts(next);
    onInvalidChange(Object.values(next).some((text) => parseCapacity(text) === undefined));
  }

  const capacityOf = (a: LayoutEnergyAsset): number | null =>
    a.type === 'battery' ? a.capacityKwh : a.capacityKwp;

  return (
    <div className="space-y-2" data-testid="layout-energy-assets">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-semibold">{t('sites.layoutSettings.energyAssets')}</h4>
          <p className="text-xs text-muted-foreground">
            {t('sites.layoutSettings.energyAssetsHint')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <CreateButton
            variant="outline"
            label={t('sites.layoutSettings.addBattery')}
            disabled={assets.length >= L.energyAssets.max}
            onClick={() => {
              setAssets([...assets, newBattery(settings)]);
            }}
          />
          {solarShown && (
            <CreateButton
              variant="outline"
              label={t('sites.layoutSettings.addSolar')}
              disabled={assets.length >= L.energyAssets.max}
              onClick={() => {
                setAssets([...assets, newSolarCanopy(settings)]);
              }}
            />
          )}
        </div>
      </div>
      {!solarShown && assets.some((a) => a.type === 'solar') && (
        <p className="text-sm text-muted-foreground" data-testid="layout-solar-hidden">
          {t('sites.layoutSettings.solarHidden')}
        </p>
      )}
      {assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('sites.layoutSettings.noEnergyAssets')}</p>
      ) : (
        <ul className="grid gap-2">
          {assets.map((a) => {
            const battery = a.type === 'battery';
            const value = capacityOf(a);
            const text = drafts[a.id] ?? (value != null ? String(value) : '');
            const invalid = parseCapacity(text) === undefined;
            const typeLabel = battery
              ? t('sites.layoutView.battery')
              : t('sites.layoutView.solarCanopy');
            return (
              <li
                key={a.id}
                className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_9rem_8rem_auto]"
                data-testid={`layout-energy-${a.id}`}
              >
                <div className="space-y-1.5">
                  <Label htmlFor={id(`name-${a.id}`)}>{typeLabel}</Label>
                  <Input
                    id={id(`name-${a.id}`)}
                    maxLength={L.energyAssetNameLength}
                    value={a.name ?? ''}
                    placeholder={typeLabel}
                    onChange={(e) => {
                      const name = e.target.value;
                      update(a.id, { name: name.trim() === '' ? null : name });
                    }}
                  />
                </div>
                <div className="col-span-2 row-start-2 space-y-1.5 sm:col-span-1 sm:row-start-auto">
                  <Label htmlFor={id(`cap-${a.id}`)}>
                    {battery
                      ? t('sites.layoutSettings.capacityKwh')
                      : t('sites.layoutSettings.capacityKwp')}
                  </Label>
                  <Input
                    id={id(`cap-${a.id}`)}
                    type="number"
                    inputMode="numeric"
                    min={L.capacity.min}
                    max={L.capacity.max}
                    step={1}
                    value={text}
                    aria-invalid={invalid}
                    onChange={(e) => {
                      const next = e.target.value;
                      setDraft({ ...drafts, [a.id]: next });
                      const parsed = parseCapacity(next);
                      if (parsed !== undefined) {
                        update(a.id, battery ? { capacityKwh: parsed } : { capacityKwp: parsed });
                      }
                    }}
                  />
                </div>
                <div className="col-span-2 row-start-3 space-y-1.5 sm:col-span-1 sm:row-start-auto">
                  {a.type === 'solar' ? (
                    <>
                      <Label htmlFor={id(`row-${a.id}`)}>
                        {t('sites.layoutSettings.solarRow')}
                      </Label>
                      <Select
                        id={id(`row-${a.id}`)}
                        value={String(a.row)}
                        onChange={(e) => {
                          update(a.id, { row: Number(e.target.value) });
                        }}
                      >
                        {Array.from({ length: settings.rows }, (_, r) => (
                          <option key={r} value={r}>
                            {t('sites.layoutSettings.rowNumber', { n: r + 1 })}
                          </option>
                        ))}
                      </Select>
                    </>
                  ) : (
                    <p className="pb-2.5 text-xs text-muted-foreground">
                      {t('sites.layoutSettings.batteryDragHint')}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t('sites.layoutSettings.removeEnergyAsset', {
                    name: a.name ?? typeLabel,
                  })}
                  onClick={() => {
                    const next = Object.fromEntries(
                      Object.entries(drafts).filter(([key]) => key !== a.id),
                    );
                    setDraft(next);
                    setAssets(assets.filter((o) => o.id !== a.id));
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
