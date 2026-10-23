// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { isBootOwnedStationSetting } from '@evtivity/lib/station-data-plan';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { OCPP_16_KEYS, OCPP_21_VARIABLES } from '@/lib/ocpp-variables';

export interface TemplateVariable {
  component: string;
  variable: string;
  /** OCPP 2.x variable instance (for example `Default`); 1.6 keys have none. */
  variableInstance?: string | null;
  value: string;
}

export type TemplateOcppVersion = '2.1' | '1.6';

export const BOOT_OWNED_ERROR_CODE = 'DATA_PLAN_SETTING_IN_TEMPLATE';

/** True when the API refused the template for a value the data plan sends at boot. */
export function isBootOwnedRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const body = error.body as { code?: unknown } | null;
  return body != null && typeof body === 'object' && body.code === BOOT_OWNED_ERROR_CODE;
}

function identity(v: TemplateVariable, version: TemplateOcppVersion): string {
  const instance = version === '1.6' ? '' : (v.variableInstance ?? '').trim();
  return `${v.component.trim()}\u0000${v.variable.trim()}\u0000${instance}`;
}

/** Indexes of rows that repeat an earlier row's component, variable and instance. */
export function duplicateVariableIndexes(
  variables: readonly TemplateVariable[],
  version: TemplateOcppVersion,
): Set<number> {
  const seen = new Set<string>();
  const dupes = new Set<number>();
  variables.forEach((v, i) => {
    if (v.variable.trim() === '') return;
    const key = identity(v, version);
    if (seen.has(key)) dupes.add(i);
    seen.add(key);
  });
  return dupes;
}

/** The variables a save sends: filled rows, an instance only on 2.1 templates and when set. */
export function templateVariablesForSave(
  variables: readonly TemplateVariable[],
  version: TemplateOcppVersion,
): TemplateVariable[] {
  return variables
    .filter((v) =>
      version === '1.6' ? v.variable !== '' : v.component !== '' && v.variable !== '',
    )
    .map((v) => {
      const instance = (v.variableInstance ?? '').trim();
      const row: TemplateVariable = {
        component: v.component,
        variable: v.variable,
        value: v.value,
      };
      if (version !== '1.6' && instance !== '') row.variableInstance = instance;
      return row;
    });
}

interface Props {
  idPrefix: string;
  ocppVersion: TemplateOcppVersion;
  variables: TemplateVariable[];
  onChange: (next: TemplateVariable[]) => void;
  /** The last save was refused for boot-owned rows: those rows are marked. */
  bootOwnedRefused: boolean;
  /** Mark repeated rows (after a save attempt). */
  showDuplicates: boolean;
}

/** The variable rows of the configuration template editor (create and edit). */
export function TemplateVariableRows({
  idPrefix,
  ocppVersion,
  variables,
  onChange,
  bootOwnedRefused,
  showDuplicates,
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  const componentNames = Object.keys(OCPP_21_VARIABLES).sort();
  const duplicates = showDuplicates
    ? duplicateVariableIndexes(variables, ocppVersion)
    : new Set<number>();

  function update(index: number, field: keyof TemplateVariable, val: string): void {
    const next = [...variables];
    const existing = next[index];
    if (existing == null) return;
    const updated: TemplateVariable = { ...existing, [field]: val };
    if (field === 'component') updated.variable = '';
    next[index] = updated;
    onChange(next);
  }

  function remove(index: number): void {
    onChange(variables.filter((_, i) => i !== index));
  }

  return (
    <>
      {variables.map((v, i) => {
        const bootOwned = isBootOwnedStationSetting(ocppVersion, v.component, v.variable);
        const marked = (bootOwned && bootOwnedRefused) || duplicates.has(i);
        const border = marked ? 'border-destructive' : '';
        const valueAndRemove = (
          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2 sm:flex">
            <Input
              placeholder={t('common.value')}
              aria-label={t('common.value')}
              value={v.value}
              className={border}
              onChange={(e) => {
                update(i, 'value', e.target.value);
              }}
            />
            <RemoveIconButton
              title={t('common.delete')}
              onClick={() => {
                remove(i);
              }}
            />
          </div>
        );
        return (
          <div key={i} className="space-y-1" data-testid={`template-variable-row-${String(i)}`}>
            {ocppVersion === '1.6' ? (
              <div className="grid grid-cols-2 gap-2 items-end">
                <Select
                  aria-label={t('configTemplates.selectKey')}
                  value={v.variable}
                  className={border}
                  onChange={(e) => {
                    update(i, 'variable', e.target.value);
                  }}
                >
                  <option value="">{t('configTemplates.selectKey')}</option>
                  {OCPP_16_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </Select>
                {valueAndRemove}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 items-end md:grid-cols-4">
                <Input
                  list={`${idPrefix}-comp-suggestions-${String(i)}`}
                  aria-label={t('configTemplates.selectComponent')}
                  placeholder={t('configTemplates.selectComponent')}
                  value={v.component}
                  className={border}
                  onChange={(e) => {
                    update(i, 'component', e.target.value);
                  }}
                />
                <datalist id={`${idPrefix}-comp-suggestions-${String(i)}`}>
                  {componentNames.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <Input
                  list={`${idPrefix}-var-suggestions-${String(i)}`}
                  aria-label={t('configTemplates.selectVariable')}
                  placeholder={t('configTemplates.selectVariable')}
                  value={v.variable}
                  className={border}
                  onChange={(e) => {
                    update(i, 'variable', e.target.value);
                  }}
                />
                <datalist id={`${idPrefix}-var-suggestions-${String(i)}`}>
                  {(OCPP_21_VARIABLES[v.component] ?? []).map((varName) => (
                    <option key={varName} value={varName} />
                  ))}
                </datalist>
                <Input
                  aria-label={t('configTemplates.variableInstance')}
                  placeholder={t('configTemplates.variableInstance')}
                  value={v.variableInstance ?? ''}
                  className={border}
                  onChange={(e) => {
                    update(i, 'variableInstance', e.target.value);
                  }}
                />
                {valueAndRemove}
              </div>
            )}
            {bootOwned && (
              <p
                className={`text-xs ${bootOwnedRefused ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {t('dataPlan.fromDataPlan')}: {t('dataPlan.fromDataPlanHint')}
              </p>
            )}
            {duplicates.has(i) && (
              <p className="text-xs text-destructive">{t('configTemplates.duplicateVariable')}</p>
            )}
          </div>
        );
      })}
    </>
  );
}
