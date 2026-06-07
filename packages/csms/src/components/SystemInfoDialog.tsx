// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { LoadingLogo } from '@/components/loading-logo';

interface SystemInfo {
  version: string;
  nodeEnv: string;
  logLevel: string;
  network: {
    bindIp: string | null;
    apiPort: string;
    apiHost: string;
    ocppPort: string;
    ocppHost: string;
    ocppHealthPort: string;
    ocppTlsPort: string | null;
    ocppTlsEnabled: boolean;
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
    ocppMaxConnectionsPerIp: string | null;
    ocppMaxMessagesPerIpPerSecond: string | null;
  };
  ocpp: {
    instanceId: string | null;
    registrationPolicy: string;
  };
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
  };
  seed: { seedDemo: string };
  secrets: {
    jwtConfigured: boolean;
    settingsEncryptionConfigured: boolean;
    stripeConfigured: boolean;
    smtpConfigured: boolean;
    twilioConfigured: boolean;
    s3Configured: boolean;
    recaptchaConfigured: boolean;
    hubjectConfigured: boolean;
    googleMapsConfigured: boolean;
  };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[200px_1fr] gap-4 border-b border-border py-2 text-sm last:border-b-0">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div>{children}</div>
    </div>
  );
}

function Configured({ on }: { on: boolean }): React.JSX.Element {
  return on ? (
    <Badge variant="success">Configured</Badge>
  ) : (
    <Badge variant="outline">Not set</Badge>
  );
}

function nullable(value: string | null): React.ReactNode {
  return value ?? <span className="text-muted-foreground">n/a</span>;
}

export function SystemInfoDialog({ open, onOpenChange }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['system-info'],
    queryFn: () => api.get<SystemInfo>('/v1/system/info'),
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('systemInfo.title')}</DialogTitle>
        </DialogHeader>
        {isLoading || data == null ? (
          <LoadingLogo size="inline" />
        ) : (
          <div className="space-y-6">
            <Section title={t('systemInfo.runtime')}>
              <Row label="version" value={data.version} />
              <Row label="NODE_ENV" value={data.nodeEnv} />
              <Row label="LOG_LEVEL" value={data.logLevel} />
              <Row label="SEED_DEMO" value={data.seed.seedDemo} />
            </Section>

            <Section title={t('systemInfo.network')}>
              <Row label="BIND_IP" value={nullable(data.network.bindIp)} />
              <Row label="API_HOST" value={data.network.apiHost} />
              <Row label="API_PORT" value={data.network.apiPort} />
              <Row label="OCPP_HOST" value={data.network.ocppHost} />
              <Row label="OCPP_PORT" value={data.network.ocppPort} />
              <Row label="OCPP_HEALTH_PORT" value={data.network.ocppHealthPort} />
              <Row label="OCPP_TLS_PORT" value={nullable(data.network.ocppTlsPort)} />
              <Row
                label="OCPP_TLS_ENABLED"
                value={data.network.ocppTlsEnabled ? 'true' : 'false'}
              />
              <Row label="METRICS_PORT" value={data.network.metricsPort} />
              <Row label="CSMS_URL" value={nullable(data.network.csmsUrl)} />
              <Row label="PORTAL_URL" value={nullable(data.network.portalUrl)} />
              <Row label="COOKIE_DOMAIN" value={nullable(data.network.cookieDomain)} />
              <Row label="CORS_ORIGIN" value={data.network.corsOrigin} />
            </Section>

            <Section title={t('systemInfo.rateLimits')}>
              <Row label="RATE_LIMIT_MAX" value={data.rateLimits.rateLimitMax} />
              <Row label="RATE_LIMIT_WINDOW" value={data.rateLimits.rateLimitWindow} />
              <Row label="AUTH_RATE_LIMIT_MAX" value={data.rateLimits.authRateLimitMax} />
              <Row
                label="OCPP_MAX_CONNECTIONS_PER_IP"
                value={nullable(data.rateLimits.ocppMaxConnectionsPerIp)}
              />
              <Row
                label="OCPP_MAX_MESSAGES_PER_IP_PER_SECOND"
                value={nullable(data.rateLimits.ocppMaxMessagesPerIpPerSecond)}
              />
            </Section>

            <Section title="OCPP">
              <Row label="OCPP_INSTANCE_ID" value={nullable(data.ocpp.instanceId)} />
              <Row label="REGISTRATION_POLICY" value={data.ocpp.registrationPolicy} />
            </Section>

            <Section title="OCPI">
              <Row label="OCPI_BASE_URL" value={nullable(data.ocpi.baseUrl)} />
              <Row label="OCPI_COUNTRY_CODE" value={data.ocpi.countryCode} />
              <Row label="OCPI_PARTY_ID" value={data.ocpi.partyId} />
              <Row label="OCPI_BUSINESS_NAME" value={nullable(data.ocpi.businessName)} />
            </Section>

            <Section title={t('systemInfo.simulator')}>
              <Row label="CSS_MODE" value={data.simulator.mode} />
              <Row
                label="CSS_ACTION_INTERVAL_MS"
                value={nullable(data.simulator.actionIntervalMs)}
              />
              <Row label="CSS_STATION_LIMIT" value={nullable(data.simulator.stationLimit)} />
            </Section>

            <Section title={t('systemInfo.integrations')}>
              <Row label="JWT_SECRET" value={<Configured on={data.secrets.jwtConfigured} />} />
              <Row
                label="SETTINGS_ENCRYPTION_KEY"
                value={<Configured on={data.secrets.settingsEncryptionConfigured} />}
              />
              <Row label="Stripe" value={<Configured on={data.secrets.stripeConfigured} />} />
              <Row label="SMTP" value={<Configured on={data.secrets.smtpConfigured} />} />
              <Row label="Twilio" value={<Configured on={data.secrets.twilioConfigured} />} />
              <Row label="S3" value={<Configured on={data.secrets.s3Configured} />} />
              <Row label="reCAPTCHA" value={<Configured on={data.secrets.recaptchaConfigured} />} />
              <Row label="Hubject" value={<Configured on={data.secrets.hubjectConfigured} />} />
              <Row
                label="Google Maps"
                value={<Configured on={data.secrets.googleMapsConfigured} />}
              />
            </Section>

            <p className="text-xs text-muted-foreground pt-2">{t('systemInfo.secretsNote')}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
