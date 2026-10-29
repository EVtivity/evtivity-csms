// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SearchInput } from '@/components/search-input';
import { api } from '@/lib/api';
import { LoadingLogo } from '@/components/loading-logo';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface OcppProcessConfig {
  version: string;
  wsCompression: boolean;
  tlsEnabled: boolean;
  tlsPort: number | null;
  clientCaConfigured: boolean;
  maxConnectionsPerIp: number;
  maxMessagesPerIpPerSecond: number;
  maxPendingAuthPerIp: number;
  trustedProxiesConfigured: boolean;
}

interface DataPlanCounts {
  wifiOrWired: number;
  cellular: number;
}

interface SystemInfo {
  version: string;
  nodeEnv: string;
  logLevel: string;
  network: {
    /** Docker Compose host bind address; null outside Compose. */
    bindIp: string | null;
    apiPort: string;
    apiHost: string;
    ocppStationTlsUrl: string | null;
    ocpiPort: string | null;
    ocpiHost: string | null;
    metricsPort: string;
    csmsUrl: string | null;
    portalUrl: string | null;
    cookieDomain: string | null;
    corsOrigin: string;
  };
  rateLimits: {
    rateLimitMax: string;
    rateLimitWindow: string;
    authRateLimitMax: string;
    authRateLimitWindow: string;
  };
  security: {
    trustProxyConfigured: boolean;
    webauthnRpId: string | null;
    sharedRateLimit: boolean;
  };
  ocpp: { registrationPolicy: string };
  ocppProcesses: Array<{
    instanceId: string;
    connectedStations: number;
    serverStartedAt: string;
    updatedAt: string;
    /** Null from a process of an earlier release, which reports no settings. */
    config: OcppProcessConfig | null;
  }>;
  ocpi: {
    baseUrl: string | null;
    countryCode: string;
    partyId: string;
    businessName: string | null;
  };
  simulator: {
    mode: string;
    actionIntervalMs: string | null;
    stationLimit: string | null;
    stationCount: number;
  };
  seed: { seedDemo: string };
  payments: {
    /** `payments.provider`: a provider id, or none when payments are off. */
    provider: string;
    /** The selected provider is available in this process and has its credentials. */
    configured: boolean;
  };
  simProviders: {
    hologram: { enabled: boolean; configured: boolean };
    '1nce': { enabled: boolean; configured: boolean };
    sessionsFetchDays: number | null;
    stationSignalEnabled: boolean;
  };
  dataPlans: { stations: DataPlanCounts; sites: DataPlanCounts };
  secrets: {
    jwtConfigured: boolean;
    settingsEncryptionConfigured: boolean;
    stripeConfigured: boolean;
    adyenConfigured: boolean;
    smtpConfigured: boolean;
    twilioConfigured: boolean;
    s3Configured: boolean;
    recaptchaConfigured: boolean;
    hubjectConfigured: boolean;
    googleMapsConfigured: boolean;
    webhookSigningConfigured: boolean;
    simHologramConfigured: boolean;
    simOneNceConfigured: boolean;
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One setting: its label, how it renders, and the text the search matches. */
interface InfoRow {
  label: string;
  value: React.ReactNode;
  text: string;
}

interface InfoGroup {
  /** A sub-table heading, such as one OCPP process. */
  heading?: string;
  rows: InfoRow[];
}

interface InfoSection {
  id: string;
  title: string;
  groups: InfoGroup[];
}

type T = TFunction;

function textRow(label: string, value: string | number | null, t: T): InfoRow {
  if (value == null) {
    const none = t('systemInfo.none');
    return {
      label,
      value: <span className="text-muted-foreground">{none}</span>,
      text: none,
    };
  }
  return { label, value: String(value), text: String(value) };
}

function configuredRow(label: string, on: boolean, t: T): InfoRow {
  const text = on ? t('systemInfo.configured') : t('systemInfo.notSet');
  return {
    label,
    value: on ? <Badge variant="success">{text}</Badge> : <Badge variant="outline">{text}</Badge>,
    text,
  };
}

function onOffRow(label: string, on: boolean, t: T): InfoRow {
  const text = on ? t('systemInfo.enabled') : t('systemInfo.disabled');
  return { label, value: text, text };
}

function buildSections(data: SystemInfo, t: T, timezone: string): InfoSection[] {
  const processGroups: InfoGroup[] =
    data.ocppProcesses.length === 0
      ? [{ rows: [textRow(t('systemInfo.processes'), t('systemInfo.noOcppProcesses'), t)] }]
      : data.ocppProcesses.map((p) => {
          const rows: InfoRow[] = [
            textRow(t('systemInfo.connectedStations'), p.connectedStations, t),
            textRow(t('systemInfo.startedAt'), formatDateTime(p.serverStartedAt, timezone), t),
          ];
          if (p.config == null) {
            rows.push(textRow(t('systemInfo.settings'), t('systemInfo.notReported'), t));
          } else {
            const c = p.config;
            rows.push(
              textRow('version', c.version, t),
              onOffRow('OCPP_WS_COMPRESSION', c.wsCompression, t),
              onOffRow('OCPP_TLS', c.tlsEnabled, t),
              textRow('OCPP_TLS_PORT', c.tlsPort, t),
              configuredRow('OCPP_TLS_CA', c.clientCaConfigured, t),
              textRow('OCPP_MAX_CONNECTIONS_PER_IP', c.maxConnectionsPerIp, t),
              textRow('OCPP_MAX_MESSAGES_PER_IP_PER_SECOND', c.maxMessagesPerIpPerSecond, t),
              textRow('OCPP_MAX_PENDING_AUTH_PER_IP', c.maxPendingAuthPerIp, t),
              configuredRow('OCPP_TRUSTED_PROXY_CIDRS', c.trustedProxiesConfigured, t),
            );
          }
          return { heading: p.instanceId, rows };
        });

  const s = data.secrets;
  return [
    {
      id: 'runtime',
      title: t('systemInfo.runtime'),
      groups: [
        {
          rows: [
            textRow('version', data.version, t),
            textRow('NODE_ENV', data.nodeEnv, t),
            textRow('LOG_LEVEL', data.logLevel, t),
            textRow('SEED_DEMO', data.seed.seedDemo, t),
          ],
        },
      ],
    },
    {
      id: 'network',
      title: t('systemInfo.network'),
      groups: [
        {
          rows: [
            // Only Docker Compose sets BIND_IP. Helm and CDK have no bind address.
            ...(data.network.bindIp != null ? [textRow('BIND_IP', data.network.bindIp, t)] : []),
            textRow('API_HOST', data.network.apiHost, t),
            textRow('API_PORT', data.network.apiPort, t),
            textRow('METRICS_PORT', data.network.metricsPort, t),
            textRow('CSMS_URL', data.network.csmsUrl, t),
            textRow('PORTAL_URL', data.network.portalUrl, t),
            textRow('OCPP_STATION_TLS_URL', data.network.ocppStationTlsUrl, t),
            textRow('COOKIE_DOMAIN', data.network.cookieDomain, t),
            textRow('CORS_ORIGIN', data.network.corsOrigin, t),
          ],
        },
      ],
    },
    {
      id: 'rateLimits',
      title: t('systemInfo.rateLimits'),
      groups: [
        {
          rows: [
            textRow('RATE_LIMIT_MAX', data.rateLimits.rateLimitMax, t),
            textRow('RATE_LIMIT_WINDOW', data.rateLimits.rateLimitWindow, t),
            textRow('AUTH_RATE_LIMIT_MAX', data.rateLimits.authRateLimitMax, t),
            textRow('AUTH_RATE_LIMIT_WINDOW', data.rateLimits.authRateLimitWindow, t),
          ],
        },
      ],
    },
    {
      id: 'security',
      title: t('systemInfo.security'),
      groups: [
        {
          rows: [
            configuredRow('TRUST_PROXY', data.security.trustProxyConfigured, t),
            textRow('WEBAUTHN_RP_ID', data.security.webauthnRpId, t),
            onOffRow(t('systemInfo.sharedRateLimit'), data.security.sharedRateLimit, t),
          ],
        },
      ],
    },
    {
      id: 'ocppProcesses',
      title: t('systemInfo.ocppProcesses'),
      groups: [
        { rows: [textRow('ocpp.registrationPolicy', data.ocpp.registrationPolicy, t)] },
        ...processGroups,
      ],
    },
    {
      id: 'ocpi',
      title: t('systemInfo.ocpi'),
      groups: [
        {
          rows: [
            textRow('OCPI_BASE_URL', data.ocpi.baseUrl, t),
            textRow('OCPI_COUNTRY_CODE', data.ocpi.countryCode, t),
            textRow('OCPI_PARTY_ID', data.ocpi.partyId, t),
            textRow('OCPI_BUSINESS_NAME', data.ocpi.businessName, t),
          ],
        },
      ],
    },
    {
      id: 'simulator',
      title: t('systemInfo.simulator'),
      groups: [
        {
          rows: [
            textRow('CSS_MODE', data.simulator.mode, t),
            textRow('CSS_ACTION_INTERVAL_MS', data.simulator.actionIntervalMs, t),
            textRow('CSS_STATION_LIMIT', data.simulator.stationLimit, t),
            textRow(t('systemInfo.simulatorStations'), data.simulator.stationCount, t),
          ],
        },
      ],
    },
    {
      id: 'payments',
      title: t('paymentProviders.systemInfo.title'),
      groups: [
        {
          rows: [
            textRow('payments.provider', data.payments.provider, t),
            ...(data.payments.provider !== 'none'
              ? [
                  configuredRow(
                    t('paymentProviders.systemInfo.providerStatus'),
                    data.payments.configured,
                    t,
                  ),
                ]
              : []),
          ],
        },
      ],
    },
    {
      id: 'simProviders',
      title: t('systemInfo.simProviders'),
      groups: [
        {
          rows: [
            onOffRow('sim.hologram.enabled', data.simProviders.hologram.enabled, t),
            configuredRow('Hologram', data.simProviders.hologram.configured, t),
            onOffRow('sim.1nce.enabled', data.simProviders['1nce'].enabled, t),
            configuredRow('1NCE', data.simProviders['1nce'].configured, t),
            textRow('sim.sessions.fetchDays', data.simProviders.sessionsFetchDays, t),
            onOffRow('sim.stationSignal.enabled', data.simProviders.stationSignalEnabled, t),
          ],
        },
      ],
    },
    {
      id: 'dataPlans',
      title: t('systemInfo.dataPlans'),
      groups: [
        {
          rows: [
            textRow(t('systemInfo.stationsWifiOrWired'), data.dataPlans.stations.wifiOrWired, t),
            textRow(t('systemInfo.stationsCellular'), data.dataPlans.stations.cellular, t),
            textRow(t('systemInfo.sitesWifiOrWired'), data.dataPlans.sites.wifiOrWired, t),
            textRow(t('systemInfo.sitesCellular'), data.dataPlans.sites.cellular, t),
          ],
        },
      ],
    },
    {
      id: 'integrations',
      title: t('systemInfo.integrations'),
      groups: [
        {
          rows: [
            configuredRow('JWT_SECRET', s.jwtConfigured, t),
            configuredRow('SETTINGS_ENCRYPTION_KEY', s.settingsEncryptionConfigured, t),
            configuredRow('Stripe', s.stripeConfigured, t),
            configuredRow('Adyen', s.adyenConfigured, t),
            configuredRow('SMTP', s.smtpConfigured, t),
            configuredRow('Twilio', s.twilioConfigured, t),
            configuredRow('S3', s.s3Configured, t),
            configuredRow('reCAPTCHA', s.recaptchaConfigured, t),
            configuredRow('Hubject', s.hubjectConfigured, t),
            configuredRow('Google Maps', s.googleMapsConfigured, t),
            configuredRow(t('systemInfo.webhookSigning'), s.webhookSigningConfigured, t),
            configuredRow(t('systemInfo.simHologramKey'), s.simHologramConfigured, t),
            configuredRow(t('systemInfo.simOneNceSecret'), s.simOneNceConfigured, t),
          ],
        },
      ],
    },
  ];
}

/** The sections, groups and rows that match the search and the section filter. */
function filterSections(sections: InfoSection[], search: string, sectionId: string): InfoSection[] {
  const needle = search.trim().toLowerCase();
  const matches = (row: InfoRow, heading: string | undefined): boolean =>
    needle === '' ||
    row.label.toLowerCase().includes(needle) ||
    row.text.toLowerCase().includes(needle) ||
    (heading?.toLowerCase().includes(needle) ?? false);
  return sections
    .filter((section) => sectionId === '' || section.id === sectionId)
    .map((section) => ({
      ...section,
      groups: section.groups
        .map((group) => ({ ...group, rows: group.rows.filter((r) => matches(r, group.heading)) }))
        .filter((group) => group.rows.length > 0),
    }))
    .filter((section) => section.groups.length > 0);
}

function SectionTable({ section }: { section: InfoSection }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2" data-testid={`system-info-section-${section.id}`}>
      <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
      {section.groups.map((group, index) => (
        <div key={group.heading ?? `group-${String(index)}`} className="space-y-1">
          {group.heading != null && (
            <p className="font-mono text-xs text-muted-foreground" data-testid="system-info-group">
              {group.heading}
            </p>
          )}
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-1/2">{t('systemInfo.setting')}</TableHead>
                  <TableHead>{t('systemInfo.value')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map((row) => (
                  <TableRow key={row.label} data-testid="system-info-row">
                    <TableCell className="font-mono text-xs text-muted-foreground whitespace-normal break-all">
                      {row.label}
                    </TableCell>
                    <TableCell className="text-sm whitespace-normal break-all">
                      {row.value}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function SystemInfoDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const [search, setSearch] = useState('');
  const [sectionId, setSectionId] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['system-info'],
    queryFn: () => api.get<SystemInfo>('/v1/system/info'),
    enabled: open,
    staleTime: 60_000,
  });

  const sections = useMemo(
    () => (data == null ? [] : buildSections(data, t, timezone)),
    [data, t, timezone],
  );
  const visible = useMemo(
    () => filterSections(sections, search, sectionId),
    [sections, search, sectionId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* grid-cols-1 (minmax(0, 1fr)): a long value never widens the dialog past the screen. */}
      <DialogContent className="max-w-3xl max-h-[85vh] grid-cols-1 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('systemInfo.title')}</DialogTitle>
          <DialogDescription>{t('systemInfo.description')}</DialogDescription>
        </DialogHeader>
        {isLoading || data == null ? (
          <LoadingLogo size="inline" />
        ) : (
          <div className="space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row">
              <SearchInput
                value={search}
                onDebouncedChange={setSearch}
                placeholder={t('systemInfo.search')}
                className="w-full sm:flex-1"
              />
              <Select
                aria-label={t('systemInfo.section')}
                value={sectionId}
                onChange={(e) => {
                  setSectionId(e.target.value);
                }}
                className="sm:w-56"
              >
                <option value="">{t('systemInfo.allSections')}</option>
                {sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title}
                  </option>
                ))}
              </Select>
            </div>
            {visible.length === 0 ? (
              <p
                className="py-6 text-center text-sm text-muted-foreground"
                data-testid="system-info-no-matches"
              >
                {t('systemInfo.noMatches')}
              </p>
            ) : (
              visible.map((section) => <SectionTable key={section.id} section={section} />)
            )}
            <p className="text-xs text-muted-foreground">{t('systemInfo.secretsNote')}</p>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
