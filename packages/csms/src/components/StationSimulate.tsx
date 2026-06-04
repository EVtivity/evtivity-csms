// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ClearableInput } from '@/components/ui/clearable-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

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
  action: string;
  label: string;
  needsEvse: boolean;
  needsToken: boolean;
}

// Mirrors the chaos VALID_BY_STATE map, keyed by `connectors.status` (lowercase
// CSMS form). Notifications are not exposed in the UI, so this list only
// covers the 9 dashboard-button actions. The simulator's per-action guards are
// the actual source of truth -- this is a UX hint only.
function getValidActions(connectorStatus: string): Set<string> {
  switch (connectorStatus) {
    case 'available':
      return new Set(['plugIn', 'authorize', 'goOffline', 'injectFault']);
    case 'preparing':
    case 'ev_connected':
    case 'occupied':
      return new Set([
        'plugIn',
        'unplug',
        'authorize',
        'startCharging',
        'goOffline',
        'injectFault',
      ]);
    case 'charging':
    case 'discharging':
    case 'suspended_ev':
    case 'suspended_evse':
    case 'idle':
      return new Set(['stopCharging', 'unplug', 'injectFault', 'goOffline']);
    case 'finishing':
      // OCPP 1.6 Finishing: cable still connected, session ended, ready
      // for the next driver. Real 1.6 stations accept a fresh RemoteStart
      // here without an Unplug/Plug-in cycle. Mirror the 2.1 'occupied'
      // post-stop set so dashboard parity holds across versions.
      return new Set([
        'plugIn',
        'unplug',
        'authorize',
        'startCharging',
        'goOffline',
        'injectFault',
      ]);
    case 'reserved':
      return new Set(['plugIn', 'authorize', 'goOffline', 'injectFault']);
    case 'faulted':
      return new Set(['clearFault', 'goOffline']);
    case 'unavailable':
      return new Set(['comeOnline', 'goOffline']);
    default:
      // Unknown status: don't gate. The simulator will no-op invalid actions.
      return new Set([
        'plugIn',
        'unplug',
        'authorize',
        'startCharging',
        'stopCharging',
        'injectFault',
        'clearFault',
        'goOffline',
        'comeOnline',
      ]);
  }
}

export function StationSimulate({
  stationId,
  evseIds,
  evses,
  isOnline,
}: StationSimulateProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selectedEvse, setSelectedEvse] = useState<number>(evseIds[0] ?? 1);
  const [idToken, setIdToken] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<string | null>(null);

  const actions: ActionConfig[] = [
    { action: 'plugIn', label: t('simulate.plugIn'), needsEvse: true, needsToken: false },
    { action: 'unplug', label: t('simulate.unplug'), needsEvse: true, needsToken: false },
    { action: 'authorize', label: t('simulate.authorize'), needsEvse: true, needsToken: true },
    {
      action: 'startCharging',
      label: t('simulate.startCharging'),
      needsEvse: true,
      needsToken: true,
    },
    {
      action: 'stopCharging',
      label: t('simulate.stopCharging'),
      needsEvse: true,
      needsToken: false,
    },
    { action: 'injectFault', label: t('simulate.injectFault'), needsEvse: true, needsToken: false },
    { action: 'clearFault', label: t('simulate.clearFault'), needsEvse: true, needsToken: false },
    { action: 'goOffline', label: t('simulate.goOffline'), needsEvse: false, needsToken: false },
    { action: 'comeOnline', label: t('simulate.comeOnline'), needsEvse: false, needsToken: false },
  ];

  const selectedConnectorStatus =
    evses?.find((e) => e.evseId === selectedEvse)?.connectors[0]?.status ?? null;

  // Build the valid-action set. When isOnline is explicitly false, only
  // comeOnline is allowed. When evses data is missing, allow everything.
  let validActions: Set<string>;
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

  const actionMutation = useMutation({
    mutationFn: async ({ action, body }: { action: string; body: Record<string, unknown> }) => {
      return api.post<{ commandId: string }>(`/v1/css/actions/${action}`, body);
    },
    onSuccess: (_data, variables) => {
      toast({ title: t('simulate.actionSent', { action: variables.action }), variant: 'success' });
      setActiveAction(null);
    },
    onError: (err: unknown, variables) => {
      const message =
        err != null && typeof err === 'object' && 'body' in err
          ? ((err as { body: { error?: string } }).body.error ?? t('simulate.actionFailed'))
          : t('simulate.actionFailed');
      toast({ title: `${variables.action}: ${message}`, variant: 'destructive' });
      setActiveAction(null);
    },
  });

  async function tokenIsKnown(token: string): Promise<boolean> {
    try {
      const res = await api.get<{ data: Array<{ idToken: string }>; total: number }>(
        `/v1/tokens?search=${encodeURIComponent(token)}&limit=10`,
      );
      return res.data.some((t) => t.idToken === token);
    } catch {
      return false;
    }
  }

  async function handleAction(config: ActionConfig): Promise<void> {
    setTokenError(null);

    if (config.needsToken) {
      const trimmed = idToken.trim();
      if (trimmed === '') {
        setTokenError(t('simulate.tokenRequired'));
        return;
      }
      const known = await tokenIsKnown(trimmed);
      if (!known) {
        setTokenError(t('simulate.tokenNotFound'));
        return;
      }
    }

    const body: Record<string, unknown> = { stationId };
    if (config.needsEvse) {
      body.evseId = selectedEvse;
    }
    if (config.needsToken) {
      body.idToken = idToken.trim();
      body.tokenType = 'ISO14443';
    }
    if (config.action === 'injectFault') {
      body.errorCode = 'InternalError';
    }
    setActiveAction(config.action);
    actionMutation.mutate({ action: config.action, body });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('simulate.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
                setTokenError(null);
              }}
              onClear={() => {
                setTokenError(null);
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
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {actions.map((config) => {
            const isLoading = activeAction === config.action && actionMutation.isPending;
            const isInvalidForState = !validActions.has(config.action);
            const disabled = actionMutation.isPending || isInvalidForState;
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
                className="relative w-full"
              >
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Spinner className="h-4 w-4" />
                  </div>
                )}
                <span className={isLoading ? 'invisible' : ''}>{config.label}</span>
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
      </CardContent>
    </Card>
  );
}
