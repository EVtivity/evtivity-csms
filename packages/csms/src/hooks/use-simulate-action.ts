// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import {
  simulateRequest,
  type FaultCode,
  type FaultMode,
  type SimulateAction,
  type SimulateRunAction,
} from '@/lib/simulate-actions';

/** Actions that send the driver's ID token with them. */
export const TOKEN_ACTIONS: ReadonlySet<SimulateAction> = new Set(['authorize', 'startCharging']);
/** Actions of the whole station (no EVSE). */
export const STATION_ACTIONS: ReadonlySet<SimulateRunAction> = new Set([
  'powerCycle',
  'goOffline',
  'comeOnline',
  'securityEvent',
]);

export interface SimulateRunOptions {
  evseId: number;
  idToken?: string;
  faultMode?: FaultMode;
  faultCode?: FaultCode;
  /** The event of the securityEvent action: an OCPP or vendor type and optional tech info. */
  securityEvent?: { type: string; techInfo?: string };
  /** Called after the action was sent, next to the success toast. */
  onSent?: () => void;
  /** Takes the error message instead of the error toast (a dialog shows it inside). */
  onFailed?: (message: string) => void;
}

/** Whether a driver token with exactly this ID exists (the simulator's Authorize needs one). */
export async function simulatorTokenIsKnown(token: string): Promise<boolean> {
  try {
    const res = await api.get<{ data: Array<{ idToken: string }>; total: number }>(
      `/v1/tokens?search=${encodeURIComponent(token)}&limit=10`,
    );
    return res.data.some((row) => row.idToken === token);
  } catch (err) {
    console.warn('Token lookup failed, treating the token as unknown', err);
    return false;
  }
}

/**
 * Sends a simulator action of one station (`POST /v1/css/actions/:action`,
 * stations:write): the station page Simulate tab and the site layout popup
 * use it. `stationId` is the OCPP station ID.
 */
export function useSimulateAction(stationId: string): {
  run: (action: SimulateRunAction, options: SimulateRunOptions) => Promise<void>;
  isPending: boolean;
  activeAction: SimulateRunAction | null;
  tokenError: string | null;
  clearTokenError: () => void;
} {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [activeAction, setActiveAction] = useState<SimulateRunAction | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async ({
      action,
      body,
    }: {
      action: string;
      body: Record<string, unknown>;
      button: SimulateRunAction;
      onSent?: (() => void) | undefined;
      onFailed?: ((message: string) => void) | undefined;
    }) => api.post<{ commandId: string }>(`/v1/css/actions/${action}`, body),
    onSuccess: (_data, variables) => {
      toast({
        title: t('simulate.actionSent', { action: t(`simulate.${variables.button}`) }),
        variant: 'success',
      });
      setActiveAction(null);
      variables.onSent?.();
    },
    onError: (err: unknown, variables) => {
      const message =
        err != null && typeof err === 'object' && 'body' in err
          ? ((err as { body: { error?: string } }).body.error ?? t('simulate.actionFailed'))
          : t('simulate.actionFailed');
      setActiveAction(null);
      if (variables.onFailed != null) {
        variables.onFailed(message);
        return;
      }
      toast({ title: `${t(`simulate.${variables.button}`)}: ${message}`, variant: 'destructive' });
    },
  });

  async function run(action: SimulateRunAction, options: SimulateRunOptions): Promise<void> {
    setTokenError(null);
    if (action === 'securityEvent') {
      const event = options.securityEvent;
      if (event == null) return;
      const techInfo = event.techInfo?.trim() ?? '';
      setActiveAction(action);
      mutation.mutate({
        action: 'securityEvent',
        body: { stationId, type: event.type, ...(techInfo !== '' ? { techInfo } : {}) },
        button: action,
        onSent: options.onSent,
        onFailed: options.onFailed,
      });
      return;
    }
    const needsToken = TOKEN_ACTIONS.has(action);
    const token = options.idToken?.trim() ?? '';
    if (needsToken) {
      if (token === '') {
        setTokenError(t('simulate.tokenRequired'));
        return;
      }
      if (!(await simulatorTokenIsKnown(token))) {
        setTokenError(t('simulate.tokenNotFound'));
        return;
      }
    }
    const { apiAction, params } = simulateRequest(
      action,
      options.faultMode ?? 'end',
      options.faultCode ?? 'InternalError',
    );
    const body: Record<string, unknown> = { stationId, ...params };
    if (!STATION_ACTIONS.has(action)) body.evseId = options.evseId;
    if (needsToken) {
      body.idToken = token;
      body.tokenType = 'ISO14443';
    }
    setActiveAction(action);
    mutation.mutate({
      action: apiAction,
      body,
      button: action,
      onSent: options.onSent,
      onFailed: options.onFailed,
    });
  }

  return {
    run,
    isPending: mutation.isPending,
    activeAction,
    tokenError,
    clearTokenError: () => {
      setTokenError(null);
    },
  };
}
