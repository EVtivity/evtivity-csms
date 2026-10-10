// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Ban, Check, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { AiConfirmationView } from './ai-turn';
import { confirmSummary } from './confirm-summary';

interface ConfirmActionCardProps {
  confirmation: AiConfirmationView;
  /** False while another turn streams or the user may not write. */
  canDecide: boolean;
  onConfirm: () => void;
  onReject: () => void;
}

function useExpired(expiresAt: string): boolean {
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    const ms = Date.parse(expiresAt) - Date.now();
    if (ms <= 0) {
      setExpired(true);
      return undefined;
    }
    const timer = setTimeout(() => {
      setExpired(true);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [expiresAt]);
  return expired;
}

const MAX_KEY_ARGUMENTS = 4;
const MAX_VALUE_CHARS = 60;

/**
 * The arguments that identify the change: scalar values, the ones in the
 * path (the resource ids) first, at most four, long values shortened.
 */
export function keyArguments(
  args: Record<string, unknown>,
  path: string,
): { key: string; value: string }[] {
  const scalars = Object.entries(args).filter(
    (e): e is [string, string | number | boolean] =>
      typeof e[1] === 'string' || typeof e[1] === 'number' || typeof e[1] === 'boolean',
  );
  const inPath = (value: string | number | boolean): boolean =>
    path.includes(encodeURIComponent(String(value)));
  const ordered = [
    ...scalars.filter(([, v]) => inPath(v)),
    ...scalars.filter(([, v]) => !inPath(v)),
  ];
  return ordered.slice(0, MAX_KEY_ARGUMENTS).map(([key, v]) => {
    const value = String(v);
    return {
      key,
      value: value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}...` : value,
    };
  });
}

/**
 * A write the assistant proposed. Nothing runs until the user confirms; the
 * confirm request carries the single-use nonce from the stream event.
 */
export function ConfirmActionCard({
  confirmation,
  canDecide,
  onConfirm,
  onReject,
}: ConfirmActionCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { event, state } = confirmation;
  const expired = useExpired(event.expiresAt);
  const decided = state === 'confirmed' || state === 'rejected';
  const busy = state === 'confirming' || state === 'rejecting';
  const args = JSON.stringify(event.arguments, null, 2);
  const keyArgs = keyArguments(event.arguments, event.path);

  return (
    <div
      role="group"
      aria-label={t('ai.confirmTitle')}
      data-testid="ai-confirm-card"
      className="space-y-2 rounded-md border border-warning bg-warning/10 p-3 text-sm"
    >
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
        <span className="flex-1">{t('ai.confirmTitle')}</span>
        {state === 'confirmed' && <Badge variant="success">{t('ai.confirmed')}</Badge>}
        {state === 'rejected' && <Badge variant="secondary">{t('ai.rejected')}</Badge>}
        {!decided && expired && <Badge variant="destructive">{t('ai.expired')}</Badge>}
      </div>
      <p className="break-words" data-testid="ai-confirm-summary">
        {confirmSummary(t, event)}
      </p>
      {keyArgs.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {keyArgs.map(({ key, value }) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-start gap-2 font-mono text-xs">
        <Badge variant="outline" className="shrink-0">
          {event.method}
        </Badge>
        <span className="break-all">{event.path}</span>
      </div>
      {args !== '{}' && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {t('ai.confirmArguments')}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded border border-border bg-background p-2 font-mono">
            {args}
          </pre>
        </details>
      )}
      {!decided && !expired && (
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canDecide || busy}
            onClick={onReject}
          >
            {state === 'rejecting' ? <Spinner className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
            <span className="ml-1">{t('ai.reject')}</span>
          </Button>
          <Button type="button" size="sm" disabled={!canDecide || busy} onClick={onConfirm}>
            {state === 'confirming' ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            <span className="ml-1">{t('ai.confirm')}</span>
          </Button>
        </div>
      )}
      {!decided && expired && (
        <p className="text-xs text-muted-foreground">{t('ai.expiredHint')}</p>
      )}
    </div>
  );
}
