// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TabPanel } from '@/components/ui/tab-panel';
import { Tooltip } from '@/components/ui/tooltip';
import { getValidActions, type FaultMode, type SimulateAction } from '@/lib/simulate-actions';
import { useSimulateAction } from '@/hooks/use-simulate-action';

interface SimEvse {
  evseId: number;
  connectors: Array<{ status: string }>;
}

interface StationSimulateProps {
  stationId: string;
  evseIds: number[];
  evses?: SimEvse[] | undefined;
  isOnline?: boolean | undefined;
}

interface ActionConfig {
  action: SimulateAction;
  label: string;
  needsEvse: boolean;
  needsToken: boolean;
}

export function StationSimulate({
  stationId,
  evseIds,
  evses,
  isOnline,
}: StationSimulateProps): React.JSX.Element {
  const { t } = useTranslation();
  const [selectedEvse, setSelectedEvse] = useState<number>(evseIds[0] ?? 1);
  const [idToken, setIdToken] = useState('');
  const [faultMode, setFaultMode] = useState<FaultMode>('end');
  const simulate = useSimulateAction(stationId);
  const { activeAction, tokenError } = simulate;

  const evseAction = (action: SimulateAction, needsToken = false): ActionConfig => ({
    action,
    label: t(`simulate.${action}`),
    needsEvse: true,
    needsToken,
  });
  const stationAction = (action: SimulateAction): ActionConfig => ({
    action,
    label: t(`simulate.${action}`),
    needsEvse: false,
    needsToken: false,
  });
  const actions: ActionConfig[] = [
    evseAction('plugIn'),
    evseAction('unplug'),
    evseAction('authorize', true),
    evseAction('startCharging', true),
    evseAction('stopCharging'),
    evseAction('evFull'),
    evseAction('suspendEv'),
    evseAction('suspendEvse'),
    evseAction('resumeCharging'),
    evseAction('injectFault'),
    evseAction('clearFault'),
    stationAction('powerCycle'),
    stationAction('goOffline'),
    stationAction('comeOnline'),
  ];

  const selectedConnectorStatus =
    evses?.find((e) => e.evseId === selectedEvse)?.connectors[0]?.status ?? null;

  // Build the valid-action set. When isOnline is explicitly false, only
  // comeOnline is allowed. When evses data is missing, allow everything.
  let validActions: Set<SimulateAction>;
  let invalidReason: string | null = null;
  if (isOnline === false) {
    validActions = new Set(['comeOnline']);
    invalidReason = t('simulate.stationOffline');
  } else if (selectedConnectorStatus != null) {
    validActions = getValidActions(selectedConnectorStatus);
    invalidReason = t('simulate.invalidForState', { status: selectedConnectorStatus });
  } else {
    validActions = new Set(actions.map((a) => a.action));
  }

  async function handleAction(config: ActionConfig): Promise<void> {
    await simulate.run(config.action, {
      evseId: selectedEvse,
      ...(config.needsToken ? { idToken } : {}),
      faultMode,
    });
  }

  return (
    <TabPanel title={t('simulate.tab')} bodyClassName="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
        <div className="grid gap-2">
          <Label htmlFor="sim-evse">{t('simulate.evseId')}</Label>
          <Input
            id="sim-evse"
            type="number"
            min={1}
            value={selectedEvse}
            onChange={(e) => {
              setSelectedEvse(Number(e.target.value));
            }}
          />
        </div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="sim-token" className="whitespace-nowrap">
              {t('simulate.idToken')}
            </Label>
            <span className="text-xs text-muted-foreground">{t('simulate.tokenUsedBy')}</span>
          </div>
          <ClearableInput
            id="sim-token"
            value={idToken}
            onChange={(v) => {
              setIdToken(v);
              simulate.clearTokenError();
            }}
            onClear={() => {
              simulate.clearTokenError();
            }}
            invalid={tokenError != null}
            clearLabel={t('common.clear')}
          />
          {tokenError != null && (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" />
              {tokenError}
            </p>
          )}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sim-fault-mode">{t('simulate.faultMode')}</Label>
          <Select
            id="sim-fault-mode"
            value={faultMode}
            onChange={(e) => {
              setFaultMode(e.target.value === 'suspend' ? 'suspend' : 'end');
            }}
          >
            <option value="end">{t('simulate.faultModeEnd')}</option>
            <option value="suspend">{t('simulate.faultModeSuspend')}</option>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {actions.map((config) => {
          const isLoading = activeAction === config.action && simulate.isPending;
          const isInvalidForState = !validActions.has(config.action);
          const disabled = simulate.isPending || isInvalidForState;
          // The spinner is absolutely positioned over invisible text so the
          // label stays in the DOM and the button width doesn't shift on click.
          const button = (
            <Button
              key={config.action}
              variant="outline"
              disabled={disabled}
              onClick={() => {
                void handleAction(config);
              }}
              className="relative w-full min-w-0"
            >
              {isLoading && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Spinner className="h-4 w-4" />
                </div>
              )}
              {/* Two lines inside the 40 px button when a label is wider than a phone column. */}
              <span
                className={`whitespace-normal text-center leading-tight ${isLoading ? 'invisible' : ''}`}
              >
                {config.label}
              </span>
            </Button>
          );
          if (isInvalidForState && invalidReason != null) {
            return (
              <Tooltip key={config.action} content={invalidReason}>
                {button}
              </Tooltip>
            );
          }
          return <div key={config.action}>{button}</div>;
        })}
      </div>
    </TabPanel>
  );
}
