// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TabPanel } from '@/components/ui/tab-panel';
import { Tooltip } from '@/components/ui/tooltip';
import {
  FAULT_CODES,
  getValidActions,
  securityEventGroups,
  type FaultCode,
  type FaultMode,
  type SimulateAction,
} from '@/lib/simulate-actions';
import { ButtonSpinner } from '@/components/ui/button-spinner';
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
  /** The station's OCPP version: picks the security event list (1.6 or 2.x names). */
  ocppProtocol?: string | null | undefined;
}

const FAULT_CODE_LABELS = {
  InternalError: 'simulate.faultCodes.internalError',
  HighTemperature: 'simulate.faultCodes.highTemp',
} as const satisfies Record<FaultCode, string>;

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
  ocppProtocol,
}: StationSimulateProps): React.JSX.Element {
  const { t } = useTranslation();
  const [selectedEvse, setSelectedEvse] = useState<number>(evseIds[0] ?? 1);
  const [idToken, setIdToken] = useState('');
  const [faultMode, setFaultMode] = useState<FaultMode>('end');
  const [faultCode, setFaultCode] = useState<FaultCode>('InternalError');
  const eventGroups = securityEventGroups(ocppProtocol);
  // The tamper event is in the 1.6 and the 2.x lists.
  const [eventType, setEventType] = useState<string>('TamperDetectionActivated');
  const [eventTechInfo, setEventTechInfo] = useState('');
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [eventError, setEventError] = useState<string | null>(null);
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
      faultCode,
    });
  }

  return (
    <TabPanel title={t('simulate.tab')} bodyClassName="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
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
        <div className="grid gap-2">
          <Label htmlFor="sim-fault-code">{t('simulate.faultType')}</Label>
          <Select
            id="sim-fault-code"
            value={faultCode}
            onChange={(e) => {
              const next = FAULT_CODES.find((c) => c === e.target.value);
              if (next != null) setFaultCode(next);
            }}
          >
            {FAULT_CODES.map((code) => (
              <option key={code} value={code}>
                {t(FAULT_CODE_LABELS[code])}
              </option>
            ))}
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
                  <ButtonSpinner />
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

      <div className="space-y-3 border-t pt-4" data-testid="sim-security-event">
        <h3 className="text-sm font-semibold">{t('simulate.securityEvent')}</h3>
        <Button
          type="button"
          variant="outline"
          disabled={simulate.isPending || isOnline === false}
          onClick={() => {
            setEventError(null);
            setEventDialogOpen(true);
          }}
        >
          {t('simulate.sendSecurityEvent')}
        </Button>
      </div>

      <ConfirmDialog
        open={eventDialogOpen}
        onOpenChange={(open) => {
          setEventDialogOpen(open);
          if (!open) setEventError(null);
        }}
        title={t('simulate.sendSecurityEvent')}
        description={t('simulate.securityEventDescription')}
        confirmLabel={t('common.send')}
        variant="default"
        asForm
        isPending={activeAction === 'securityEvent' && simulate.isPending}
        onConfirm={() => {
          setEventError(null);
          void simulate.run('securityEvent', {
            evseId: selectedEvse,
            securityEvent: { type: eventType, techInfo: eventTechInfo },
            onSent: () => {
              setEventDialogOpen(false);
            },
            onFailed: (message) => {
              setEventError(message);
            },
          });
          return false;
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="sim-security-event-type">{t('simulate.securityEventType')}</Label>
          <Select
            id="sim-security-event-type"
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
            }}
          >
            {eventGroups.map((group) => (
              <optgroup key={group.severity} label={t(`severity.${group.severity}`)}>
                {group.types.map((type) => (
                  <option key={type} value={type}>
                    {t(`simulate.securityEvents.${type}`, { defaultValue: type })}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('simulate.securityEventOcppType', { type: eventType })}
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="sim-security-event-tech-info">
            {t('simulate.securityEventTechInfo')}
          </Label>
          <Input
            id="sim-security-event-tech-info"
            maxLength={255}
            value={eventTechInfo}
            onChange={(e) => {
              setEventTechInfo(e.target.value);
            }}
          />
        </div>
        {eventError != null && (
          <p role="alert" className="flex items-center gap-1 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {eventError}
          </p>
        )}
      </ConfirmDialog>
    </TabPanel>
  );
}
