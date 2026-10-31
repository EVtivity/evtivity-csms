// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The Site Settings of Edit Layout: the site type, lot size, spot size, lane,
// facing, the transformers (a parking lot only; an office or retail site
// keeps them hidden) and the batteries and solar canopies. Every valid change shows in the layout at once and is
// saved with the layout Save.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import {
  LAYOUT_FACINGS,
  LAYOUT_GRID_LIMITS,
  energyAssetsOf,
  lotExtentM,
  placeEnergyAsset,
  showsTransformers,
  SITE_TYPES,
  siteTypeOf,
  snapTransformerToGrass,
  TRANSFORMER_CLEARANCE_M,
  type LayoutFacing,
  type SiteType,
  type LayoutTransformer,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { EnergyAssetsSettings } from './EnergyAssetsSettings';

const L = LAYOUT_GRID_LIMITS;

const SITE_TYPE_LABEL = {
  parking_lot: 'sites.layoutSettings.siteTypeParkingLot',
  office_retail: 'sites.layoutSettings.siteTypeOfficeRetail',
} as const satisfies Record<SiteType, string>;

type LotField = 'spotsPerRow' | 'rows' | 'spotWidthM' | 'spotDepthM' | 'laneWidthM';

const LOT_FIELDS: ReadonlyArray<{ field: LotField; integer: boolean }> = [
  { field: 'spotsPerRow', integer: true },
  { field: 'rows', integer: true },
  { field: 'spotWidthM', integer: false },
  { field: 'spotDepthM', integer: false },
  { field: 'laneWidthM', integer: false },
];

/** A typed lot value, or null when it is empty or out of range. */
export function parseLotField(field: LotField, text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const { min, max } = L[field];
  if (value < min || value > max) return null;
  if (field === 'spotsPerRow' || field === 'rows') return Number.isInteger(value) ? value : null;
  return Math.abs(value * 10 - Math.round(value * 10)) < 1e-9 ? value : null;
}

/** A typed rated kVA: null for empty, undefined when invalid. */
export function parseRatedKva(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < L.ratedKva.min || value > L.ratedKva.max)
    return undefined;
  return value;
}

/** A new transformer: on the grass at the front of the lot, right of the others. */
export function newTransformer(settings: SiteLayoutSettings): LayoutTransformer {
  let n = settings.transformers.length + 1;
  const ids = new Set(settings.transformers.map((t) => t.id));
  while (ids.has(`tx-${String(n)}`)) n++;
  const spot = snapTransformerToGrass(
    Math.min(lotExtentM(settings).width, 4 + 4 * settings.transformers.length),
    -TRANSFORMER_CLEARANCE_M - 1.5,
    settings,
  );
  return { id: `tx-${String(n)}`, name: null, ratedKva: null, ...spot };
}

interface LayoutSettingsPanelProps {
  settings: SiteLayoutSettings;
  /** Stations at the site: a lot smaller than this cannot be saved. */
  stationCount: number;
  onChange: (settings: SiteLayoutSettings) => void;
  /** True while a typed value is invalid (Save waits for it). */
  onInvalidChange: (invalid: boolean) => void;
}

export function LayoutSettingsPanel({
  settings,
  stationCount,
  onChange,
  onInvalidChange,
}: LayoutSettingsPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<LotField, string>>(() => ({
    spotsPerRow: String(settings.spotsPerRow),
    rows: String(settings.rows),
    spotWidthM: String(settings.spotWidthM),
    spotDepthM: String(settings.spotDepthM),
    laneWidthM: String(settings.laneWidthM),
  }));
  const [kvaDrafts, setKvaDrafts] = useState<Record<string, string>>({});
  const [assetsInvalid, setAssetsInvalid] = useState(false);

  const invalidLot = LOT_FIELDS.filter(({ field }) => parseLotField(field, drafts[field]) == null);
  const kvaText = (tr: LayoutTransformer): string =>
    kvaDrafts[tr.id] ?? (tr.ratedKva != null ? String(tr.ratedKva) : '');
  const invalidKva = (text: string): boolean => parseRatedKva(text) === undefined;

  function report(
    nextDrafts: Record<LotField, string>,
    nextKva: Record<string, string>,
    nextAssetsInvalid: boolean = assetsInvalid,
  ): void {
    const bad =
      LOT_FIELDS.some(({ field }) => parseLotField(field, nextDrafts[field]) == null) ||
      Object.values(nextKva).some(invalidKva) ||
      nextAssetsInvalid;
    onInvalidChange(bad);
  }

  function setLotField(field: LotField, text: string): void {
    const next = { ...drafts, [field]: text };
    setDrafts(next);
    report(next, kvaDrafts);
    const value = parseLotField(field, text);
    if (value != null) {
      const grid = { ...settings, [field]: value };
      // Transformers and batteries stay on the grass when the lot grows under
      // them; a solar canopy stays over a row of the lot.
      onChange({
        ...grid,
        transformers: grid.transformers.map((tr) => ({
          ...tr,
          ...snapTransformerToGrass(tr.x, tr.z, grid),
        })),
        energyAssets: energyAssetsOf(grid).map((a) => placeEnergyAsset(a, grid)),
      });
    }
  }

  function updateTransformer(id: string, patch: Partial<LayoutTransformer>): void {
    onChange({
      ...settings,
      transformers: settings.transformers.map((tr) => (tr.id === id ? { ...tr, ...patch } : tr)),
    });
  }

  const capacity = settings.spotsPerRow * settings.rows;
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
      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor={id('siteType')}>{t('sites.layoutSettings.siteType')}</Label>
        <Select
          id={id('siteType')}
          value={siteTypeOf(settings)}
          onChange={(e) => {
            onChange({ ...settings, siteType: e.target.value as SiteType });
          }}
        >
          {SITE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(SITE_TYPE_LABEL[type])}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{t('sites.layoutSettings.siteTypeHint')}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {LOT_FIELDS.map(({ field, integer }) => {
          const invalid = invalidLot.some((f) => f.field === field);
          return (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={id(field)}>{t(`sites.layoutSettings.${field}`)}</Label>
              {integer ? (
                <Input
                  id={id(field)}
                  type="number"
                  inputMode="numeric"
                  min={L[field].min}
                  max={L[field].max}
                  step={1}
                  value={drafts[field]}
                  aria-invalid={invalid}
                  onChange={(e) => {
                    setLotField(field, e.target.value);
                  }}
                />
              ) : (
                <DecimalInput
                  id={id(field)}
                  decimalScale={1}
                  value={drafts[field]}
                  aria-invalid={invalid}
                  onChange={(v) => {
                    setLotField(field, v);
                  }}
                />
              )}
              <p className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {t('sites.layoutSettings.range', {
                  min: L[field].min,
                  max: L[field].max,
                  unit: integer ? '' : ' m',
                })}
              </p>
            </div>
          );
        })}
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
      </div>
      {capacity < stationCount && (
        <p className="text-sm text-destructive" role="alert">
          {t('sites.layoutSettings.tooSmall', { spots: capacity, stations: stationCount })}
        </p>
      )}
      {!showsTransformers(settings) ? (
        <p className="text-sm text-muted-foreground" data-testid="layout-transformers-hidden">
          {t('sites.layoutSettings.transformersHidden')}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold">{t('sites.layoutSettings.transformers')}</h4>
              <p className="text-xs text-muted-foreground">
                {t('sites.layoutSettings.transformersHint')}
              </p>
            </div>
            <CreateButton
              variant="outline"
              label={t('sites.layoutSettings.addTransformer')}
              disabled={settings.transformers.length >= L.transformers.max}
              onClick={() => {
                onChange({
                  ...settings,
                  transformers: [...settings.transformers, newTransformer(settings)],
                });
              }}
            />
          </div>
          {settings.transformers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('sites.layoutSettings.noTransformers')}
            </p>
          ) : (
            <ul className="grid gap-2">
              {settings.transformers.map((tr, i) => {
                const kva = kvaText(tr);
                const kvaInvalid = invalidKva(kva);
                return (
                  <li
                    key={tr.id}
                    className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_10rem_auto]"
                    data-testid={`layout-transformer-${tr.id}`}
                  >
                    <div className="space-y-1.5">
                      <Label htmlFor={id(`name-${tr.id}`)}>
                        {t('sites.layoutSettings.transformerName', { n: i + 1 })}
                      </Label>
                      <Input
                        id={id(`name-${tr.id}`)}
                        maxLength={L.transformerNameLength}
                        value={tr.name ?? ''}
                        placeholder={t('sites.layoutView.transformer')}
                        onChange={(e) => {
                          const text = e.target.value;
                          updateTransformer(tr.id, { name: text.trim() === '' ? null : text });
                        }}
                      />
                    </div>
                    <div className="col-span-2 row-start-2 space-y-1.5 sm:col-span-1 sm:row-start-auto">
                      <Label htmlFor={id(`kva-${tr.id}`)}>
                        {t('sites.layoutSettings.ratedKva')}
                      </Label>
                      <Input
                        id={id(`kva-${tr.id}`)}
                        type="number"
                        inputMode="numeric"
                        min={L.ratedKva.min}
                        max={L.ratedKva.max}
                        step={1}
                        value={kva}
                        aria-invalid={kvaInvalid}
                        onChange={(e) => {
                          const text = e.target.value;
                          const nextKva = { ...kvaDrafts, [tr.id]: text };
                          setKvaDrafts(nextKva);
                          report(drafts, nextKva);
                          const value = parseRatedKva(text);
                          if (value !== undefined) updateTransformer(tr.id, { ratedKva: value });
                        }}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t('sites.layoutSettings.removeTransformer', { n: i + 1 })}
                      onClick={() => {
                        const nextKva = Object.fromEntries(
                          Object.entries(kvaDrafts).filter(([id]) => id !== tr.id),
                        );
                        setKvaDrafts(nextKva);
                        report(drafts, nextKva);
                        onChange({
                          ...settings,
                          transformers: settings.transformers.filter((o) => o.id !== tr.id),
                        });
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
      )}
      <EnergyAssetsSettings
        settings={settings}
        onChange={onChange}
        onInvalidChange={(invalid) => {
          setAssetsInvalid(invalid);
          report(drafts, kvaDrafts, invalid);
        }}
      />
    </section>
  );
}
