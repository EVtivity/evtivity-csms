// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The second screen of the layout station popup for a simulator station: the
// common simulator actions that apply to the selected EVSE's state, sent
// through the same API and checks as the station page's Simulate tab
// (`useSimulateAction`).

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { getValidActions, type SimulateAction } from '@/lib/simulate-actions';
import { TOKEN_ACTIONS, useSimulateAction } from '@/hooks/use-simulate-action';
import type { LayoutStation } from './StationCard';

/** The actions the popup offers, in this order; each shows only when it applies. */
export const LAYOUT_SIMULATE_ACTIONS: readonly SimulateAction[] = [
  'plugIn',
  'unplug',
  'startCharging',
  'stopCharging',
  'suspendEv',
  'resumeCharging',
  'injectFault',
  'clearFault',
  'goOffline',
  'comeOnline',
];

/** The actions that apply to a station and the connector status of one EVSE (`getValidActions`). */
export function layoutSimulateActions(
  station: Pick<LayoutStation, 'isOnline'>,
  connectorStatus: string | null,
): SimulateAction[] {
  if (!station.isOnline) return ['comeOnline'];
  const valid = connectorStatus != null ? getValidActions(connectorStatus) : null;
  return LAYOUT_SIMULATE_ACTIONS.filter(
    (a) => a !== 'comeOnline' && (valid == null || valid.has(a)),
  );
}

export function LayoutSimulatePanel({
  station,
  onBack,
}: {
  station: LayoutStation;
  onBack: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const evses = [...station.evses].sort((a, b) => a.evseId - b.evseId);
  const [evseId, setEvseId] = useState<number>(evses[0]?.evseId ?? 1);
  const [idToken, setIdToken] = useState('');
  const simulate = useSimulateAction(station.stationId);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, []);

  const status = evses.find((e) => e.evseId === evseId)?.connectors[0]?.status ?? null;
  const actions = layoutSimulateActions(station, status);
  const needsToken = actions.some((a) => TOKEN_ACTIONS.has(a));
  const evseSelectId = `layout-sim-evse-${station.id}`;
  const tokenInputId = `layout-sim-token-${station.id}`;

  return (
    <div
      data-testid="layout-simulate-panel"
      className="animate-slide-in-from-right motion-reduce:animate-none"
    >
      <div className="flex items-center gap-2">
        <Button
          ref={backRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('sites.layoutView.simulateBack')}
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <h3 className="min-w-0 truncate text-base font-semibold">
          {t('sites.layoutView.simulateTitle', { id: station.stationId })}
        </h3>
      </div>
      <div className="mt-3 grid gap-3">
        {evses.length > 1 && (
          <div className="grid gap-1.5">
            <Label htmlFor={evseSelectId}>{t('simulate.evseId')}</Label>
            <Select
              id={evseSelectId}
              value={String(evseId)}
              onChange={(e) => {
                setEvseId(Number(e.target.value));
              }}
            >
              {evses.map((e) => (
                <option key={e.evseId} value={e.evseId}>
                  {t('sites.layoutView.evse', { id: e.evseId })}
                  {e.connectors[0] != null
                    ? ` · ${t(`status.${e.connectors[0].status}`, { defaultValue: e.connectors[0].status })}`
                    : ''}
                </option>
              ))}
            </Select>
          </div>
        )}
        {needsToken && (
          <div className="grid gap-1.5">
            <Label htmlFor={tokenInputId}>{t('simulate.idToken')}</Label>
            <ClearableInput
              id={tokenInputId}
              value={idToken}
              onChange={(v) => {
                setIdToken(v);
                simulate.clearTokenError();
              }}
              onClear={simulate.clearTokenError}
              invalid={simulate.tokenError != null}
              clearLabel={t('common.clear')}
            />
            {simulate.tokenError != null && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" aria-hidden="true" />
                {simulate.tokenError}
              </p>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2" data-testid="layout-simulate-actions">
          {actions.map((action) => {
            const loading = simulate.activeAction === action && simulate.isPending;
            return (
              <Button
                key={action}
                type="button"
                variant="outline"
                size="wrap"
                className="relative min-w-0"
                disabled={simulate.isPending}
                data-testid={`layout-simulate-${action}`}
                onClick={() => {
                  void simulate.run(action, {
                    evseId,
                    ...(TOKEN_ACTIONS.has(action) ? { idToken } : {}),
                  });
                }}
              >
                {loading && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  </span>
                )}
                <span className={loading ? 'invisible' : ''}>{t(`simulate.${action}`)}</span>
              </Button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
