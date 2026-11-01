// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Site Settings of Edit Layout: the site type (read-only here, changed on
// the Details tab) and only the settings of that type. Parking Lot: spots per
// row, rows and facing. Office or Retail: the charger positions and how they
// are mounted. Curbside: the chargers on each side of the street. Depot: the
// bus bays, the truck lanes and the facing. A parking lot, a depot and a
// custom site also have the Power Equipment button (transformers, batteries
// and solar canopies in a dialog, PowerEquipment.tsx). Spot sizes are standard. The other
// types' values stay in the settings, so switching the type back restores
// them. Every valid change shows in the layout at once and is saved with the
// layout Save.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  CHARGER_MOUNTINGS,
  LAYOUT_FACINGS,
  LAYOUT_GRID_LIMITS,
  chargerMountingOf,
  energyAssetsOf,
  layoutCapacity,
  placeEnergyAsset,
  siteTypeOf,
  chargerPlacementOf,
  snapTransformerToGrass,
  type ChargerMounting,
  type LayoutFacing,
  type SiteLayoutSettings,
  type SiteType,
} from '@evtivity/lib/site-layout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { CHARGER_PLACEMENT_LABEL, SITE_TYPE_LABEL } from '@/components/site/site-type';
import { cn } from '@/lib/utils';
import { PowerEquipmentField } from './PowerEquipment';

const L = LAYOUT_GRID_LIMITS;

/** The count fields of every site type (all whole numbers). */
export type CountField =
  | 'spotsPerRow'
  | 'rows'
  | 'chargers'
  | 'chargersLeft'
  | 'chargersRight'
  | 'busBays'
  | 'truckLanes';

/** The count fields each site type shows. */
export const COUNT_FIELDS: Record<SiteType, readonly CountField[]> = {
  parking_lot: ['spotsPerRow', 'rows'],
  office_retail: ['chargers'],
  curbside: ['chargersLeft', 'chargersRight'],
  depot: ['busBays', 'truckLanes'],
  custom: [],
};

function limitOf(field: CountField): { min: number; max: number } {
  if (field === 'chargers') return L.chargers;
  if (field === 'chargersLeft' || field === 'chargersRight') return L.chargersPerSide;
  if (field === 'busBays' || field === 'truckLanes') return L.depotSpots;
  return L[field];
}

/** A typed count, or null when it is empty, not a whole number or out of range. */
export function parseCountField(field: CountField, text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value)) return null;
  const { min, max } = limitOf(field);
  return value < min || value > max ? null : value;
}

/** The two counts a site type needs one of (a street's sides, a depot's areas), or null. */
const PAIRED_COUNTS: Partial<Record<SiteType, readonly [CountField, CountField]>> = {
  curbside: ['chargersLeft', 'chargersRight'],
  depot: ['busBays', 'truckLanes'],
};

/** Whether both paired counts are typed as 0 (a street needs a charger, a depot a bay or lane). */
function pairEmpty(type: SiteType, drafts: Record<CountField, string>): boolean {
  const pair = PAIRED_COUNTS[type];
  return (
    pair != null &&
    parseCountField(pair[0], drafts[pair[0]]) === 0 &&
    parseCountField(pair[1], drafts[pair[1]]) === 0
  );
}

/** Whether the typed counts of a site type are valid together. */
function countsValid(type: SiteType, drafts: Record<CountField, string>): boolean {
  const fields = COUNT_FIELDS[type];
  if (fields.some((f) => parseCountField(f, drafts[f]) == null)) return false;
  return !pairEmpty(type, drafts);
}

const MOUNTING_LABEL = {
  wall: 'sites.layoutSettings.mountingWall',
  stall: 'sites.layoutSettings.mountingStall',
} as const satisfies Record<ChargerMounting, string>;

const MOUNTING_HINT = {
  wall: 'sites.layoutSettings.mountingWallHint',
  stall: 'sites.layoutSettings.mountingStallHint',
} as const satisfies Record<ChargerMounting, string>;

interface LayoutSettingsPanelProps {
  siteId: string;
  settings: SiteLayoutSettings;
  /** Stations at the site: a layout with fewer spots than this cannot be saved. */
  stationCount: number;
  onChange: (settings: SiteLayoutSettings) => void;
  /** True while a typed value is invalid (Save waits for it). */
  onInvalidChange: (invalid: boolean) => void;
}

export function LayoutSettingsPanel({
  siteId,
  settings,
  stationCount,
  onChange,
  onInvalidChange,
}: LayoutSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const siteType = siteTypeOf(settings);
  const [drafts, setDrafts] = useState<Record<CountField, string>>(() => ({
    spotsPerRow: String(settings.spotsPerRow),
    rows: String(settings.rows),
    chargers: String(settings.chargers ?? 1),
    chargersLeft: String(settings.chargersLeft ?? 0),
    chargersRight: String(settings.chargersRight ?? 0),
    busBays: String(settings.busBays ?? 1),
    truckLanes: String(settings.truckLanes ?? 0),
  }));
  const sidesEmpty = pairEmpty(siteType, drafts);

  function setCountField(field: CountField, text: string): void {
    const next = { ...drafts, [field]: text };
    setDrafts(next);
    onInvalidChange(!countsValid(siteType, next));
    const value = parseCountField(field, text);
    if (value == null || !countsValid(siteType, next)) return;
    const changed = { ...settings, [field]: value };
    if (siteType !== 'parking_lot' && siteType !== 'depot') {
      onChange(changed);
      return;
    }
    // Transformers and batteries stay on the grass when the lot (a depot's
    // yard) grows under them; a solar canopy stays over a row of the lot.
    onChange({
      ...changed,
      transformers: changed.transformers.map((tr) => ({
        ...tr,
        ...snapTransformerToGrass(tr.x, tr.z, changed),
      })),
      energyAssets: energyAssetsOf(changed).map((a) => placeEnergyAsset(a, changed)),
    });
  }

  const capacity = layoutCapacity(settings);
  const mounting = chargerMountingOf(settings);
  const id = (name: string): string => `layout-settings-${name}`;

  return (
    <section
      className="mb-3 space-y-4 rounded-lg border bg-card p-4"
      aria-labelledby={id('title')}
      data-testid="layout-settings-panel"
    >
      <div>
        <h3 id={id('title')} className="text-sm font-semibold">
          {t('sites.layoutSettings.title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('sites.layoutSettings.hint')}</p>
      </div>
      <div className="space-y-1 text-sm" data-testid="layout-settings-site-type">
        <p className="text-muted-foreground">{t('sites.layoutSettings.siteType')}</p>
        <p className="font-medium">{t(SITE_TYPE_LABEL[siteType])}</p>
        {siteType === 'parking_lot' && (
          <p className="font-medium" data-testid="layout-settings-charger-placement">
            {t('sites.layoutSettings.chargerPlacement')}:{' '}
            {t(CHARGER_PLACEMENT_LABEL[chargerPlacementOf(settings)])}
          </p>
        )}
        <Link
          to={`/sites/${siteId}`}
          className="text-xs text-link underline-offset-4 hover:underline"
        >
          {t('sites.layoutSettings.siteTypeOnDetails')}
        </Link>
      </div>
      {siteType === 'custom' && (
        <p className="text-xs text-muted-foreground" data-testid="layout-settings-custom-hint">
          {t('sites.layoutSettings.customHint')}
        </p>
      )}
      <div
        className={cn(
          'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6',
          siteType === 'custom' && 'hidden',
        )}
      >
        {COUNT_FIELDS[siteType].map((field) => {
          const invalid = parseCountField(field, drafts[field]) == null || sidesEmpty;
          const limit = limitOf(field);
          return (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={id(field)}>{t(`sites.layoutSettings.${field}`)}</Label>
              <Input
                id={id(field)}
                type="number"
                inputMode="numeric"
                min={limit.min}
                max={limit.max}
                step={1}
                value={drafts[field]}
                aria-invalid={invalid}
                onChange={(e) => {
                  setCountField(field, e.target.value);
                }}
              />
              <p className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {t('sites.layoutSettings.range', { min: limit.min, max: limit.max, unit: '' })}
              </p>
            </div>
          );
        })}
        {(siteType === 'parking_lot' || siteType === 'depot') && (
          <div className="space-y-1.5">
            <Label htmlFor={id('facing')}>{t('sites.layoutSettings.facingDeg')}</Label>
            <Select
              id={id('facing')}
              value={String(settings.facingDeg)}
              onChange={(e) => {
                onChange({ ...settings, facingDeg: Number(e.target.value) as LayoutFacing });
              }}
            >
              {LAYOUT_FACINGS.map((deg) => (
                <option key={deg} value={deg}>
                  {t('sites.layoutSettings.facingOption', { deg })}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{t('sites.layoutSettings.facingHint')}</p>
          </div>
        )}
        {siteType === 'office_retail' && (
          <div className="col-span-2 space-y-1.5 sm:col-span-2">
            <Label htmlFor={id('mounting')}>{t('sites.layoutSettings.mounting')}</Label>
            <Select
              id={id('mounting')}
              value={mounting}
              onChange={(e) => {
                onChange({ ...settings, mounting: e.target.value as ChargerMounting });
              }}
            >
              {CHARGER_MOUNTINGS.map((m) => (
                <option key={m} value={m}>
                  {t(MOUNTING_LABEL[m])}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">{t(MOUNTING_HINT[mounting])}</p>
          </div>
        )}
      </div>
      {siteType === 'office_retail' && (
        <p className="text-xs text-muted-foreground">{t('sites.layoutSettings.chargersHint')}</p>
      )}
      {siteType === 'curbside' && (
        <p className={sidesEmpty ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}>
          {t('sites.layoutSettings.sidesHint')}
        </p>
      )}
      {siteType === 'depot' && (
        <p
          className={sidesEmpty ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}
          data-testid="layout-settings-depot-hint"
        >
          {t('sites.layoutSettings.depotHint')}
        </p>
      )}
      {capacity < stationCount && (
        <p className="text-sm text-destructive" role="alert">
          {siteType === 'parking_lot'
            ? t('sites.layoutSettings.tooSmall', { spots: capacity, stations: stationCount })
            : siteType === 'depot'
              ? t('sites.layoutSettings.tooFewDepotSpots', {
                  spots: capacity,
                  stations: stationCount,
                })
              : t('sites.layoutSettings.tooFewChargers', {
                  spots: capacity,
                  stations: stationCount,
                })}
        </p>
      )}
      <PowerEquipmentField siteId={siteId} settings={settings} onChange={onChange} />
    </section>
  );
}
