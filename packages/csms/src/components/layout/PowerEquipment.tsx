// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The power equipment of a site layout: its transformers, batteries and solar
// canopies, edited in a dialog behind one Power Equipment button with a
// one-line summary (owner request 2026-10-31: keep the Site Settings short).
// Only the site types that show such equipment have the button (a parking
// lot, a depot and a custom site). Apply hands the edited equipment to the
// layout, which stores it with its Save; Cancel drops the edits. Without
// write access the dialog lists the equipment read-only. The switchboards
// are not edited here: they follow the site's load management panels. A muted
// note under the button and at the top of the dialog says the equipment is for
// the layout only and links to the Load Management tab (owner request
// 2026-11-01).

import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Check, Trash2, Zap } from 'lucide-react';
import {
  LAYOUT_GRID_LIMITS,
  TRANSFORMER_CLEARANCE_M,
  clampFreePoint,
  energyAssetsOf,
  layoutEquipmentGround,
  showsBatteries,
  showsSolar,
  showsTransformers,
  siteTypeOf,
  snapTransformerToGrass,
  usesFreePositions,
  type LayoutTransformer,
  type SiteLayoutSettings,
} from '@evtivity/lib/site-layout';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EnergyAssetsSettings } from './EnergyAssetsSettings';

const L = LAYOUT_GRID_LIMITS;

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
  // A custom site: left of the site origin, below the others.
  if (usesFreePositions(settings)) {
    const spot = clampFreePoint(-8, -4 - 4 * settings.transformers.length);
    return { id: `tx-${String(n)}`, name: null, ratedKva: null, ...spot };
  }
  // At the edge of the lot (a depot: of its yard), right of the others.
  const ground = layoutEquipmentGround(settings);
  const spot = snapTransformerToGrass(
    Math.min(ground.maxX, ground.minX + 4 + 4 * settings.transformers.length),
    ground.minZ - TRANSFORMER_CLEARANCE_M,
    settings,
  );
  return { id: `tx-${String(n)}`, name: null, ratedKva: null, ...spot };
}

/** Whether the site type shows power equipment (and so the Power Equipment button). */
export function showsPowerEquipment(settings: SiteLayoutSettings): boolean {
  return showsTransformers(settings) || showsBatteries(settings) || showsSolar(settings);
}

/** The equipment counts the summary names. */
export function powerEquipmentCounts(settings: SiteLayoutSettings): {
  transformers: number;
  batteries: number;
  solar: number;
} {
  const assets = energyAssetsOf(settings);
  return {
    transformers: showsTransformers(settings) ? settings.transformers.length : 0,
    batteries: showsBatteries(settings) ? assets.filter((a) => a.type === 'battery').length : 0,
    solar: showsSolar(settings) ? assets.filter((a) => a.type === 'solar').length : 0,
  };
}

interface EquipmentEditorProps {
  settings: SiteLayoutSettings;
  onChange: (settings: SiteLayoutSettings) => void;
  onInvalidChange: (invalid: boolean) => void;
}

/** The transformers and the batteries and solar canopies, editable. */
function EquipmentEditor({
  settings,
  onChange,
  onInvalidChange,
}: EquipmentEditorProps): React.JSX.Element {
  const { t } = useTranslation();
  const [kvaDrafts, setKvaDrafts] = useState<Record<string, string>>({});
  const [assetsInvalid, setAssetsInvalid] = useState(false);
  const kvaText = (tr: LayoutTransformer): string =>
    kvaDrafts[tr.id] ?? (tr.ratedKva != null ? String(tr.ratedKva) : '');
  const invalidKva = (text: string): boolean => parseRatedKva(text) === undefined;
  const id = (name: string): string => `power-equipment-${name}`;

  function report(nextKva: Record<string, string>, nextAssets: boolean): void {
    onInvalidChange(Object.values(nextKva).some(invalidKva) || nextAssets);
  }

  function updateTransformer(trId: string, patch: Partial<LayoutTransformer>): void {
    onChange({
      ...settings,
      transformers: settings.transformers.map((tr) => (tr.id === trId ? { ...tr, ...patch } : tr)),
    });
  }

  return (
    <div className="space-y-4">
      {showsTransformers(settings) && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-semibold">{t('sites.layoutSettings.transformers')}</h4>
              <p className="text-xs text-muted-foreground">
                {siteTypeOf(settings) === 'custom'
                  ? t('sites.layoutSettings.transformersHintCustom')
                  : t('sites.layoutSettings.transformersHint')}
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
                          report(nextKva, assetsInvalid);
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
                          Object.entries(kvaDrafts).filter(([key]) => key !== tr.id),
                        );
                        setKvaDrafts(nextKva);
                        report(nextKva, assetsInvalid);
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
      {(showsBatteries(settings) || showsSolar(settings)) && (
        <EnergyAssetsSettings
          settings={settings}
          onChange={onChange}
          onInvalidChange={(invalid) => {
            setAssetsInvalid(invalid);
            report(kvaDrafts, invalid);
          }}
        />
      )}
    </div>
  );
}

/** The equipment as a read-only list (no write access). */
function EquipmentList({ settings }: { settings: SiteLayoutSettings }): React.JSX.Element {
  const { t } = useTranslation();
  const assets = energyAssetsOf(settings);
  const transformers = showsTransformers(settings) ? settings.transformers : [];
  const batteries = showsBatteries(settings) ? assets.filter((a) => a.type === 'battery') : [];
  const solar = showsSolar(settings) ? assets.filter((a) => a.type === 'solar') : [];
  const rows = [
    ...transformers.map((tr, i) => ({
      id: tr.id,
      name: tr.name ?? t('sites.layoutSettings.transformerName', { n: i + 1 }),
      value: tr.ratedKva != null ? `${String(tr.ratedKva)} kVA` : null,
    })),
    ...batteries.map((a) => ({
      id: a.id,
      name: a.name ?? t('sites.layoutView.battery'),
      value: a.capacityKwh != null ? `${String(a.capacityKwh)} kWh` : null,
    })),
    ...solar.map((a) => ({
      id: a.id,
      name: a.name ?? t('sites.layoutView.solarCanopy'),
      value: a.capacityKwp != null ? `${String(a.capacityKwp)} kWp` : null,
    })),
  ];
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('sites.layoutSettings.powerEquipmentNone')}
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border text-sm" data-testid="power-equipment-list">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <span>{r.name}</span>
          {r.value != null && <span className="text-muted-foreground">{r.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * The power equipment is drawn on the layout only: load management never reads
 * it. Switchboards, panels and circuits come from the Load Management tab.
 */
function PowerEquipmentNote({
  siteId,
  testId,
}: {
  siteId: string;
  testId: string;
}): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId}>
      <Trans
        i18nKey="sites.layoutSettings.powerEquipmentLayoutOnly"
        components={{
          loadManagement: (
            <Link
              to={`/sites/${siteId}?tab=load-management`}
              className="text-link underline-offset-4 hover:underline"
            />
          ),
        }}
      />
    </p>
  );
}

interface PowerEquipmentFieldProps {
  siteId: string;
  settings: SiteLayoutSettings;
  /** Takes the applied equipment; omitted for a read-only view. */
  onChange?: (settings: SiteLayoutSettings) => void;
}

/**
 * The Power Equipment button with its one-line summary, and the dialog it
 * opens. Nothing for a site type without power equipment.
 */
export function PowerEquipmentField({
  siteId,
  settings,
  onChange,
}: PowerEquipmentFieldProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<SiteLayoutSettings>(settings);
  const [invalid, setInvalid] = useState(false);
  // A new dialog opening starts a new editor (its typed drafts reset).
  const [session, setSession] = useState(0);
  if (!showsPowerEquipment(settings)) return null;
  const readOnly = onChange == null;
  const counts = powerEquipmentCounts(settings);
  const parts = [
    counts.transformers > 0
      ? t('sites.layoutSettings.powerEquipmentTransformers', { count: counts.transformers })
      : null,
    counts.batteries > 0
      ? t('sites.layoutSettings.powerEquipmentBatteries', { count: counts.batteries })
      : null,
    counts.solar > 0
      ? t('sites.layoutSettings.powerEquipmentSolar', { count: counts.solar })
      : null,
  ].filter((p): p is string => p != null);
  const summary =
    parts.length > 0 ? parts.join(', ') : t('sites.layoutSettings.powerEquipmentNone');

  return (
    <div className="space-y-1" data-testid="power-equipment">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setDraft(settings);
            setInvalid(false);
            setSession((n) => n + 1);
            setOpen(true);
          }}
        >
          <Zap className="h-4 w-4" />
          {t('sites.layoutSettings.powerEquipment')}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="power-equipment-summary">
          {summary}
        </span>
      </div>
      <PowerEquipmentNote siteId={siteId} testId="power-equipment-note" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-[95vw] overflow-y-auto md:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('sites.layoutSettings.powerEquipment')}</DialogTitle>
            <DialogDescription>
              {readOnly
                ? t('sites.layoutSettings.powerEquipmentReadOnly')
                : t('sites.layoutSettings.powerEquipmentHint')}
            </DialogDescription>
          </DialogHeader>
          <PowerEquipmentNote siteId={siteId} testId="power-equipment-dialog-note" />
          {readOnly ? (
            <EquipmentList settings={settings} />
          ) : (
            <EquipmentEditor
              key={session}
              settings={draft}
              onChange={setDraft}
              onInvalidChange={setInvalid}
            />
          )}
          <DialogFooter>
            {readOnly ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                }}
              >
                {t('common.close')}
              </Button>
            ) : (
              <>
                <CancelButton
                  onClick={() => {
                    setOpen(false);
                  }}
                />
                <Button
                  type="button"
                  disabled={invalid}
                  onClick={() => {
                    onChange({
                      ...settings,
                      transformers: draft.transformers,
                      energyAssets: energyAssetsOf(draft),
                    });
                    setOpen(false);
                  }}
                >
                  <Check className="h-4 w-4" />
                  {t('sites.layoutSettings.powerEquipmentApply')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
