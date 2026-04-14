// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';

interface StationSimulateProps {
  stationId: string;
  evseIds: number[];
}

interface ActionConfig {
  action: string;
  label: string;
  needsEvse: boolean;
  needsToken: boolean;
}

export function StationSimulate({ stationId, evseIds }: StationSimulateProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [selectedEvse, setSelectedEvse] = useState<number>(evseIds[0] ?? 1);
  const [idToken, setIdToken] = useState('TEST001');
  const [activeAction, setActiveAction] = useState<string | null>(null);

  const actions: ActionConfig[] = [
    { action: 'plugIn', label: t('simulate.plugIn'), needsEvse: true, needsToken: false },
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
    { action: 'unplug', label: t('simulate.unplug'), needsEvse: true, needsToken: false },
    { action: 'injectFault', label: t('simulate.injectFault'), needsEvse: true, needsToken: false },
    { action: 'clearFault', label: t('simulate.clearFault'), needsEvse: true, needsToken: false },
    { action: 'goOffline', label: t('simulate.goOffline'), needsEvse: false, needsToken: false },
    { action: 'comeOnline', label: t('simulate.comeOnline'), needsEvse: false, needsToken: false },
  ];

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

  function handleAction(config: ActionConfig): void {
    const body: Record<string, unknown> = { stationId };
    if (config.needsEvse) {
      body.evseId = selectedEvse;
    }
    if (config.needsToken) {
      body.idToken = idToken;
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
            <Label htmlFor="sim-token">{t('simulate.idToken')}</Label>
            <Input
              id="sim-token"
              value={idToken}
              onChange={(e) => {
                setIdToken(e.target.value);
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {actions.map((config) => {
            const isLoading = activeAction === config.action && actionMutation.isPending;
            return (
              <Button
                key={config.action}
                variant="outline"
                disabled={actionMutation.isPending}
                onClick={() => {
                  handleAction(config);
                }}
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {config.label}
              </Button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
