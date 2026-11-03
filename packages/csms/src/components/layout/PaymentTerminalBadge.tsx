// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The payment terminal mark of the 2D card, next to the connection icon: one
// card reader icon per station with an active paired terminal, green while
// every terminal is online, muted while one is offline or not reported.

import { useTranslation } from 'react-i18next';
import { CreditCard } from 'lucide-react';
import { statusIconColor } from '@/lib/chart-theme';
import { useDarkTheme } from '@/hooks/use-dark-theme';
import type { LayoutTerminal } from './layout-terminals';

export type TerminalState = 'online' | 'offline' | 'unknown';

/** The state the mark shows: offline when one is offline, unknown when one is not reported. */
export function terminalsState(terminals: readonly LayoutTerminal[]): TerminalState {
  if (terminals.some((t) => t.online === false)) return 'offline';
  if (terminals.some((t) => t.online == null)) return 'unknown';
  return 'online';
}

export function PaymentTerminalBadge({
  terminals,
}: {
  terminals: readonly LayoutTerminal[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const dark = useDarkTheme();
  if (terminals.length === 0) return null;
  const state = terminalsState(terminals);
  const stateLabel =
    state === 'unknown'
      ? t('sites.layoutView.terminalStatusUnknown')
      : t(`status.${state}`, { defaultValue: state });
  const label = t('sites.layoutView.terminalIconLabel', {
    names: terminals.map((x) => x.name).join(', '),
    state: stateLabel,
  });
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="payment-terminal-badge"
      data-state={state}
      className="inline-flex shrink-0 text-muted-foreground"
      // Online: the charging green at 3:1 or more on the card in this theme.
      style={state === 'online' ? { color: statusIconColor('charging', dark) } : undefined}
    >
      <CreditCard aria-hidden="true" className="h-3.5 w-3.5" />
    </span>
  );
}
