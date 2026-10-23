// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { formatDateTime } from '@/lib/timezone';
import { SIM_KIND_KEYS } from './SimTimelineCard';
import {
  formatDataBytes,
  providerName,
  stateBadgeVariant,
  usageNearLimit,
  type SimCapabilities,
  type SimStoredStatus,
} from './sim-connectivity';

/** Labels of the normalized provider states. */
export const SIM_STATE_KEYS = {
  active: 'stations.sim.state.active',
  pending: 'stations.sim.state.pending',
  suspended: 'stations.sim.state.suspended',
  inactive: 'stations.sim.state.inactive',
  deactivated: 'stations.sim.state.deactivated',
  test: 'stations.sim.state.test',
  unknown: 'stations.sim.state.unknown',
} as const;

const CAPABILITY_KEYS = {
  networkName: 'stations.sim.network',
  radioAccessTechnology: 'stations.sim.radioAccessTechnology',
  cellId: 'stations.sim.cellId',
  usage: 'stations.sim.usage',
} as const;

interface SimProviderStatusCardProps {
  provider: string;
  capabilities: SimCapabilities | null;
  /** The provider status stored by the last Refresh, null before one. */
  status: SimStoredStatus | null;
  statusFetchedAt: string | null;
  network: {
    name: string | null;
    radioAccessTechnology: string | null;
    cellId: string | null;
  } | null;
  recentAlerts: Array<{ kind: string; receivedAt: string }> | undefined;
  /** Show the recent alerts (the station tab only once the SIM is confirmed). */
  showRecentAlerts: boolean;
  timezone: string;
  /** The label of the provider state (the SIM page says Provider Status, apart from the CSMS status). */
  stateLabel?: string;
  /** The text without recent alerts (the station tab names the station, the SIM page the SIM). */
  noRecentAlertsLabel?: string;
  /** The card's actions, right of the title. */
  actions?: React.ReactNode;
  /** A notice above the status, such as the unconfirmed attachment warning. */
  notice?: React.ReactNode;
  /** Content after the card body, such as the confirmation dialogs of the actions. */
  children?: React.ReactNode;
}

/**
 * The provider status of a SIM as the last Refresh stored it: provider, state,
 * session, network, APN, profile, last session, usage, what the provider does
 * not report, and the recent alerts. Shared by the station Connectivity tab and
 * the SIM page; each passes its own actions.
 */
export function SimProviderStatusCard({
  provider: providerId,
  capabilities,
  status,
  statusFetchedAt,
  network,
  recentAlerts,
  showRecentAlerts,
  timezone,
  stateLabel,
  noRecentAlertsLabel,
  actions,
  notice,
  children,
}: SimProviderStatusCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const provider = providerName(providerId);
  const missing = (Object.keys(CAPABILITY_KEYS) as Array<keyof typeof CAPABILITY_KEYS>).filter(
    (c) => capabilities != null && !capabilities[c],
  );
  const na = t('common.na');
  const time = (iso: string | null | undefined): string =>
    iso == null ? na : formatDateTime(iso, timezone);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle>{t('stations.sim.fromProviderTitle')}</CardTitle>
        {actions != null && <div className="flex flex-wrap gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className="space-y-4">
        {notice}
        <p className="text-xs text-muted-foreground">
          {statusFetchedAt == null
            ? t('stations.sim.notFetchedYet')
            : t('stations.sim.fetchedAt', { time: formatDateTime(statusFetchedAt, timezone) })}
        </p>
        <DescriptionList>
          <DescriptionItem label={t('stations.sim.provider')}>{provider}</DescriptionItem>
          {status != null && (
            <>
              <DescriptionItem label={stateLabel ?? t('stations.sim.stateLabel')}>
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant={stateBadgeVariant(status.state)}>
                    {t(SIM_STATE_KEYS[status.state])}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t('stations.sim.providerState', {
                      provider,
                      state: status.providerState,
                    })}
                  </span>
                </span>
              </DescriptionItem>
              <DescriptionItem label={t('stations.sim.inSession')}>
                {status.inSession == null
                  ? na
                  : status.inSession
                    ? t('stations.sim.inSessionSince', { time: time(status.openSessionBeganAt) })
                    : t('common.no')}
              </DescriptionItem>
            </>
          )}
          {capabilities?.networkName === true && (
            <DescriptionItem label={t('stations.sim.network')}>
              {network?.name ?? na}
              {capabilities.radioAccessTechnology && network?.radioAccessTechnology != null
                ? ` (${network.radioAccessTechnology})`
                : ''}
            </DescriptionItem>
          )}
          {capabilities?.cellId === true && (
            <DescriptionItem label={t('stations.sim.cellId')}>
              {network?.cellId ?? na}
            </DescriptionItem>
          )}
          {status != null && (
            <>
              <DescriptionItem label={t('stations.sim.apn')}>{status.apn ?? na}</DescriptionItem>
              <DescriptionItem label={t('stations.sim.profile')}>
                {status.profileName ?? na}
              </DescriptionItem>
              <DescriptionItem label={t('stations.sim.lastSession')}>
                {time(status.lastSessionAt)}
              </DescriptionItem>
            </>
          )}
          {capabilities?.usage === true && status != null && (
            <DescriptionItem label={t('stations.sim.usage')}>
              {status.usage == null
                ? na
                : status.usage.periodEnd == null
                  ? formatDataBytes(status.usage.bytes)
                  : t('stations.sim.usageUntil', {
                      amount: formatDataBytes(status.usage.bytes),
                      date: formatDateTime(status.usage.periodEnd, timezone),
                    })}
            </DescriptionItem>
          )}
        </DescriptionList>
        {status?.usage != null && usageNearLimit(status.usage) && (
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              {t('stations.sim.usageWarning', {
                amount: formatDataBytes(status.usage.bytes),
                limit: formatDataBytes(status.usage.limitBytes ?? 0),
              })}
            </AlertDescription>
          </Alert>
        )}
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('stations.sim.notReported', {
              provider,
              fields: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
                missing.map((c) => t(CAPABILITY_KEYS[c])),
              ),
            })}
          </p>
        )}
        {showRecentAlerts && capabilities?.alerts === true && (
          <div className="space-y-2" data-testid="sim-recent-alerts">
            <h4 className="text-sm font-medium">{t('stations.sim.recentAlertsTitle')}</h4>
            {(recentAlerts ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {noRecentAlertsLabel ?? t('stations.sim.noRecentAlerts')}
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {(recentAlerts ?? []).map((alert) => {
                  const key = SIM_KIND_KEYS[alert.kind];
                  return (
                    <li
                      key={`${alert.kind}-${alert.receivedAt}`}
                      className="flex flex-wrap items-center gap-x-2"
                    >
                      <span className="font-medium">
                        {key != null ? t(key as 'stations.sim.kind.session') : alert.kind}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(alert.receivedAt, timezone)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{t('stations.sim.alertsRefreshNote')}</p>
          </div>
        )}
      </CardContent>
      {children}
    </Card>
  );
}
