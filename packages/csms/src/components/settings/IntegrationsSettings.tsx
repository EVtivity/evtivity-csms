// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, Loader2, ChevronDown } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { ReservationSettings } from '@/components/settings/ReservationSettings';

interface IntegrationsSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function IntegrationsSettings({ settings }: IntegrationsSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [integrationsSubTab, setIntegrationsSubTab] = useTab('ocppDefaults', 'sub');

  // FTP state
  const [ftpHost, setFtpHost] = useState('');
  const [ftpPort, setFtpPort] = useState('21');
  const [ftpUsername, setFtpUsername] = useState('');
  const [ftpPassword, setFtpPassword] = useState('');
  const [ftpPath, setFtpPath] = useState('');

  // S3 state
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Region, setS3Region] = useState('');
  const [s3AccessKeyId, setS3AccessKeyId] = useState('');
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
  const [s3PolicyOpen, setS3PolicyOpen] = useState(false);
  const [s3CorsOpen, setS3CorsOpen] = useState(false);

  // Feature toggles
  const [reservationEnabled, setReservationEnabled] = useState(true);
  const [supportEnabled, setSupportEnabled] = useState(true);
  const [fleetEnabled, setFleetEnabled] = useState(true);
  const [guestChargingEnabled, setGuestChargingEnabled] = useState(true);

  // Idling and session
  const [idlingGracePeriod, setIdlingGracePeriod] = useState('30');
  const [staleSessionTimeout, setStaleSessionTimeout] = useState('24');

  // Pricing
  const [splitBillingEnabled, setSplitBillingEnabled] = useState(true);
  const [pricingDisplayFormat, setPricingDisplayFormat] = useState('standard');
  const [pushDisplayEnabled, setPushDisplayEnabled] = useState(true);

  // Google Maps
  const [googleMapsApiKey, setGoogleMapsApiKey] = useState('');
  const [googleMapsDefaultLat, setGoogleMapsDefaultLat] = useState('39.8283');
  const [googleMapsDefaultLng, setGoogleMapsDefaultLng] = useState('-98.5795');
  const [googleMapsDefaultZoom, setGoogleMapsDefaultZoom] = useState('4');

  // Sentry
  const [sentryEnabled, setSentryEnabled] = useState(false);
  const [sentryDsn, setSentryDsn] = useState('');
  const [sentryEnvironment, setSentryEnvironment] = useState('production');

  // OCPP defaults
  const [ocppHeartbeatInterval, setOcppHeartbeatInterval] = useState('300');
  const [ocppMeterValueInterval, setOcppMeterValueInterval] = useState('60');
  const [ocppClockAlignedInterval, setOcppClockAlignedInterval] = useState('60');
  const [ocppConnectionTimeout, setOcppConnectionTimeout] = useState('120');
  const [ocppResetRetries, setOcppResetRetries] = useState('3');
  const [ocppApprovalRequired, setOcppApprovalRequired] = useState(true);
  const [ocppSampledMeasurands, setOcppSampledMeasurands] = useState(
    'Energy.Active.Import.Register,Power.Active.Import,Voltage,Temperature,SoC,Current.Import',
  );
  const [ocppAlignedMeasurands, setOcppAlignedMeasurands] = useState(
    'Energy.Active.Import.Register,Power.Active.Import,Voltage,Temperature,SoC,Current.Import',
  );
  const [ocppTxEndedMeasurands, setOcppTxEndedMeasurands] = useState(
    'Energy.Active.Import.Register',
  );

  // PnC
  const { data: pncSettings } = useQuery({
    queryKey: ['pnc-settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/pnc/settings'),
  });

  const pncEnabled = pncSettings != null && pncSettings['pnc.enabled'] === true;
  const [pncProvider, setPncProvider] = useState('manual');
  const [pncHubjectBaseUrl, setPncHubjectBaseUrl] = useState('');
  const [pncHubjectClientId, setPncHubjectClientId] = useState('');
  const [pncHubjectClientSecret, setPncHubjectClientSecret] = useState('');
  const [pncHubjectTokenUrl, setPncHubjectTokenUrl] = useState('');
  const [pncWarningDays, setPncWarningDays] = useState('30');
  const [pncCriticalDays, setPncCriticalDays] = useState('7');

  const roamingEnabled = settings != null && settings['roaming.enabled'] === true;

  useEffect(() => {
    if (pncSettings == null) return;
    const s = (key: string): string => {
      const v = pncSettings[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    setPncProvider(s('pnc.provider') || 'manual');
    setPncHubjectBaseUrl(s('pnc.hubject.baseUrl'));
    setPncHubjectClientId(s('pnc.hubject.clientId'));
    setPncHubjectClientSecret('');
    setPncHubjectTokenUrl(s('pnc.hubject.tokenUrl'));
    setPncWarningDays(s('pnc.expirationWarningDays') || '30');
    setPncCriticalDays(s('pnc.expirationCriticalDays') || '7');
  }, [pncSettings]);

  useEffect(() => {
    if (settings == null) return;
    const s = (key: string): string => {
      const v = settings[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    setFtpHost(s('ftp.host'));
    setFtpPort(s('ftp.port'));
    setFtpUsername(s('ftp.username'));
    setFtpPassword(s('ftp.password'));
    setFtpPath(s('ftp.path'));
    setS3Bucket(s('s3.bucket'));
    setS3Region(s('s3.region'));
    setS3AccessKeyId('');
    setS3SecretAccessKey('');
    setReservationEnabled(settings['reservation.enabled'] !== false);
    setSupportEnabled(settings['support.enabled'] !== false);
    setFleetEnabled(settings['fleet.enabled'] !== false);
    setGuestChargingEnabled(settings['guest.enabled'] !== false);
    const gp = settings['idling.gracePeriodMinutes'];
    setIdlingGracePeriod(gp != null ? Number(gp).toString() : '30');
    const sst = settings['session.staleTimeoutHours'];
    setStaleSessionTimeout(sst != null ? Number(sst).toString() : '24');
    setSplitBillingEnabled(settings['pricing.splitBillingEnabled'] !== false);
    const displayFmt = settings['pricing.displayFormat'];
    setPricingDisplayFormat(typeof displayFmt === 'string' ? displayFmt : 'standard');
    setPushDisplayEnabled(settings['pricing.pushDisplayEnabled'] !== false);
    const mapsKey = settings['googleMaps.apiKey'];
    setGoogleMapsApiKey(typeof mapsKey === 'string' ? mapsKey : '');
    const mapsLat = settings['googleMaps.defaultLat'];
    setGoogleMapsDefaultLat(
      typeof mapsLat === 'string' || typeof mapsLat === 'number' ? String(mapsLat) : '39.8283',
    );
    const mapsLng = settings['googleMaps.defaultLng'];
    setGoogleMapsDefaultLng(
      typeof mapsLng === 'string' || typeof mapsLng === 'number' ? String(mapsLng) : '-98.5795',
    );
    const mapsZoom = settings['googleMaps.defaultZoom'];
    setGoogleMapsDefaultZoom(
      typeof mapsZoom === 'string' || typeof mapsZoom === 'number' ? String(mapsZoom) : '4',
    );
    setSentryEnabled(settings['sentry.enabled'] === true);
    const sDsn = settings['sentry.dsn'];
    setSentryDsn(typeof sDsn === 'string' ? sDsn : '');
    const sEnv = settings['sentry.environment'];
    setSentryEnvironment(typeof sEnv === 'string' ? sEnv : 'production');
    const hbi = settings['ocpp.heartbeatInterval'];
    setOcppHeartbeatInterval(hbi != null ? Number(hbi).toString() : '300');
    const mvi = settings['ocpp.meterValueInterval'];
    setOcppMeterValueInterval(mvi != null ? Number(mvi).toString() : '60');
    const cai = settings['ocpp.clockAlignedInterval'];
    setOcppClockAlignedInterval(cai != null ? Number(cai).toString() : '60');
    const ct = settings['ocpp.connectionTimeout'];
    setOcppConnectionTimeout(ct != null ? Number(ct).toString() : '120');
    const rr = settings['ocpp.resetRetries'];
    setOcppResetRetries(rr != null ? Number(rr).toString() : '3');
    const rp = settings['ocpp.registrationPolicy'];
    setOcppApprovalRequired(rp !== 'open');
    const sm = settings['ocpp.sampledMeasurands'];
    setOcppSampledMeasurands(
      typeof sm === 'string'
        ? sm
        : 'Energy.Active.Import.Register,Power.Active.Import,Voltage,Temperature,SoC,Current.Import',
    );
    const am = settings['ocpp.alignedMeasurands'];
    setOcppAlignedMeasurands(
      typeof am === 'string'
        ? am
        : 'Energy.Active.Import.Register,Power.Active.Import,Voltage,Temperature,SoC,Current.Import',
    );
    const tem = settings['ocpp.txEndedMeasurands'];
    setOcppTxEndedMeasurands(typeof tem === 'string' ? tem : 'Energy.Active.Import.Register');
  }, [settings]);

  // Mutations
  const ftpMutation = useMutation({
    mutationFn: (vals: {
      host: string;
      port: string;
      username: string;
      password: string;
      path: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/ftp.host', { value: vals.host }),
        api.put('/v1/settings/ftp.port', { value: Number(vals.port) }),
        api.put('/v1/settings/ftp.username', { value: vals.username }),
        api.put('/v1/settings/ftp.password', { value: vals.password }),
        api.put('/v1/settings/ftp.path', { value: vals.path }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const s3Mutation = useMutation({
    mutationFn: (vals: {
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    }) => api.put('/v1/settings/s3', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['s3-status'] });
    },
  });

  const s3TestMutation = useMutation({
    mutationFn: () => api.post('/v1/settings/s3/test', {}),
  });

  const roamingMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/roaming.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const reservationMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put('/v1/settings/reservation.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const supportMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/support.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const fleetMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/fleet.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const guestChargingMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/guest.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const ocppDefaultsMutation = useMutation({
    mutationFn: (vals: {
      heartbeatInterval: number;
      meterValueInterval: number;
      clockAlignedInterval: number;
      sampledMeasurands: string;
      alignedMeasurands: string;
      txEndedMeasurands: string;
      connectionTimeout: number;
      resetRetries: number;
      approvalRequired: boolean;
    }) =>
      Promise.all([
        api.put('/v1/settings/ocpp.heartbeatInterval', { value: vals.heartbeatInterval }),
        api.put('/v1/settings/ocpp.meterValueInterval', { value: vals.meterValueInterval }),
        api.put('/v1/settings/ocpp.clockAlignedInterval', { value: vals.clockAlignedInterval }),
        api.put('/v1/settings/ocpp.sampledMeasurands', { value: vals.sampledMeasurands }),
        api.put('/v1/settings/ocpp.alignedMeasurands', { value: vals.alignedMeasurands }),
        api.put('/v1/settings/ocpp.txEndedMeasurands', { value: vals.txEndedMeasurands }),
        api.put('/v1/settings/ocpp.connectionTimeout', { value: vals.connectionTimeout }),
        api.put('/v1/settings/ocpp.resetRetries', { value: vals.resetRetries }),
        api.put('/v1/settings/ocpp.registrationPolicy', {
          value: vals.approvalRequired ? 'approval-required' : 'open',
        }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const idlingGracePeriodMutation = useMutation({
    mutationFn: (minutes: number) =>
      api.put('/v1/settings/idling.gracePeriodMinutes', { value: minutes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const staleSessionTimeoutMutation = useMutation({
    mutationFn: (hours: number) =>
      api.put('/v1/settings/session.staleTimeoutHours', { value: hours }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const googleMapsMutation = useMutation({
    mutationFn: (vals: {
      apiKey: string;
      defaultLat: string;
      defaultLng: string;
      defaultZoom: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/googleMaps.apiKey', { value: vals.apiKey }),
        api.put('/v1/settings/googleMaps.defaultLat', { value: vals.defaultLat }),
        api.put('/v1/settings/googleMaps.defaultLng', { value: vals.defaultLng }),
        api.put('/v1/settings/googleMaps.defaultZoom', { value: vals.defaultZoom }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const sentryMutation = useMutation({
    mutationFn: (vals: { enabled: boolean; dsn: string; environment: string }) =>
      Promise.all([
        api.put('/v1/settings/sentry.enabled', { value: vals.enabled }),
        api.put('/v1/settings/sentry.dsn', { value: vals.dsn }),
        api.put('/v1/settings/sentry.environment', { value: vals.environment }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const pncToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/pnc/settings', { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const pncSaveMutation = useMutation({
    mutationFn: (vals: {
      provider: string;
      hubjectBaseUrl: string;
      hubjectClientId: string;
      hubjectClientSecret: string;
      hubjectTokenUrl: string;
      expirationWarningDays: number;
      expirationCriticalDays: number;
    }) => api.put('/v1/pnc/settings', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-settings'] });
    },
  });

  const pncTestMutation = useMutation({
    mutationFn: () => api.post('/v1/pnc/settings/test-provider', {}),
  });

  const pricingSettingsMutation = useMutation({
    mutationFn: (vals: {
      splitBillingEnabled: boolean;
      displayFormat: string;
      pushDisplayEnabled: boolean;
    }) =>
      Promise.all([
        api.put('/v1/settings/pricing.splitBillingEnabled', { value: vals.splitBillingEnabled }),
        api.put('/v1/settings/pricing.displayFormat', { value: vals.displayFormat }),
        api.put('/v1/settings/pricing.pushDisplayEnabled', { value: vals.pushDisplayEnabled }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return (
    <Tabs value={integrationsSubTab} onValueChange={setIntegrationsSubTab}>
      <TabsList>
        <TabsTrigger value="ocppDefaults">{t('settings.ocppDefaults')}</TabsTrigger>
        <TabsTrigger value="roaming">{t('settings.roaming')}</TabsTrigger>
        <TabsTrigger value="pnc">{t('settings.pnc')}</TabsTrigger>
        <TabsTrigger value="reservation">{t('settings.reservation')}</TabsTrigger>
        <TabsTrigger value="support">{t('settings.support')}</TabsTrigger>
        <TabsTrigger value="fleet">{t('settings.fleet')}</TabsTrigger>
        <TabsTrigger value="guest">{t('settings.guestCharging')}</TabsTrigger>
        <TabsTrigger value="idling">{t('settings.idling')}</TabsTrigger>
        <TabsTrigger value="session">{t('settings.session')}</TabsTrigger>
        <TabsTrigger value="pricing">{t('settings.pricingSettings')}</TabsTrigger>
        <TabsTrigger value="s3">{t('settings.s3')}</TabsTrigger>
        <TabsTrigger value="ftp">{t('settings.ftpServer')}</TabsTrigger>
        <TabsTrigger value="googleMaps">{t('settings.googleMaps')}</TabsTrigger>
        <TabsTrigger value="sentry">{t('settings.sentry')}</TabsTrigger>
      </TabsList>
      <TabsContent value="ocppDefaults" className="mt-4 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.ocppStationConfigTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('settings.ocppStationConfigDescription')}
            </p>
            <div className="grid gap-4 max-w-lg">
              <div className="grid gap-2">
                <Label htmlFor="ocpp-meter-value">{t('settings.ocppMeterValueInterval')}</Label>
                <Input
                  id="ocpp-meter-value"
                  type="number"
                  min={0}
                  step={1}
                  value={ocppMeterValueInterval}
                  onChange={(e) => {
                    setOcppMeterValueInterval(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppMeterValueIntervalHelp')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ocpp-clock-aligned">{t('settings.ocppClockAlignedInterval')}</Label>
                <Input
                  id="ocpp-clock-aligned"
                  type="number"
                  min={0}
                  step={1}
                  value={ocppClockAlignedInterval}
                  onChange={(e) => {
                    setOcppClockAlignedInterval(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppClockAlignedIntervalHelp')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ocpp-sampled-measurands">
                  {t('settings.ocppSampledMeasurands')}
                </Label>
                <Input
                  id="ocpp-sampled-measurands"
                  type="text"
                  value={ocppSampledMeasurands}
                  onChange={(e) => {
                    setOcppSampledMeasurands(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppSampledMeasurandsHelp')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ocpp-aligned-measurands">
                  {t('settings.ocppAlignedMeasurands')}
                </Label>
                <Input
                  id="ocpp-aligned-measurands"
                  type="text"
                  value={ocppAlignedMeasurands}
                  onChange={(e) => {
                    setOcppAlignedMeasurands(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppAlignedMeasurandsHelp')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ocpp-tx-ended-measurands">
                  {t('settings.ocppTxEndedMeasurands')}
                </Label>
                <Input
                  id="ocpp-tx-ended-measurands"
                  type="text"
                  value={ocppTxEndedMeasurands}
                  onChange={(e) => {
                    setOcppTxEndedMeasurands(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppTxEndedMeasurandsHelp')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('settings.ocppBootResponseTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('settings.ocppBootResponseDescription')}
            </p>
            <div className="grid gap-4 max-w-lg">
              <div className="grid gap-2">
                <Label htmlFor="ocpp-heartbeat">{t('settings.ocppHeartbeatInterval')}</Label>
                <Input
                  id="ocpp-heartbeat"
                  type="number"
                  min={1}
                  step={1}
                  value={ocppHeartbeatInterval}
                  onChange={(e) => {
                    setOcppHeartbeatInterval(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppHeartbeatIntervalHelp')}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('settings.ocppCsmsConfigTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('settings.ocppCsmsConfigDescription')}
            </p>
            <div className="grid gap-4 max-w-lg">
              <div className="grid gap-2">
                <Label htmlFor="ocpp-connection-timeout">
                  {t('settings.ocppConnectionTimeout')}
                </Label>
                <Input
                  id="ocpp-connection-timeout"
                  type="number"
                  min={1}
                  step={1}
                  value={ocppConnectionTimeout}
                  onChange={(e) => {
                    setOcppConnectionTimeout(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppConnectionTimeoutHelp')}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ocpp-reset-retries">{t('settings.ocppResetRetries')}</Label>
                <Input
                  id="ocpp-reset-retries"
                  type="number"
                  min={0}
                  step={1}
                  value={ocppResetRetries}
                  onChange={(e) => {
                    setOcppResetRetries(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.ocppResetRetriesHelp')}
                </p>
              </div>
              <div className="flex items-center justify-between">
                <div className="grid gap-1">
                  <Label>{t('settings.ocppApprovalRequired')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.ocppApprovalRequiredHelp')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ocppApprovalRequired}
                  onClick={() => {
                    setOcppApprovalRequired(!ocppApprovalRequired);
                  }}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${ocppApprovalRequired ? 'bg-primary' : 'bg-muted'}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${ocppApprovalRequired ? 'translate-x-5' : 'translate-x-0'}`}
                  />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        <SaveButton
          isPending={ocppDefaultsMutation.isPending}
          type="button"
          onClick={() => {
            const hb = parseInt(ocppHeartbeatInterval, 10);
            const mv = parseInt(ocppMeterValueInterval, 10);
            const ca = parseInt(ocppClockAlignedInterval, 10);
            const ct = parseInt(ocppConnectionTimeout, 10);
            const rr = parseInt(ocppResetRetries, 10);
            if (!isNaN(hb) && !isNaN(mv) && !isNaN(ca) && !isNaN(ct) && !isNaN(rr)) {
              ocppDefaultsMutation.mutate({
                heartbeatInterval: hb,
                meterValueInterval: mv,
                clockAlignedInterval: ca,
                sampledMeasurands: ocppSampledMeasurands,
                alignedMeasurands: ocppAlignedMeasurands,
                txEndedMeasurands: ocppTxEndedMeasurands,
                connectionTimeout: ct,
                resetRetries: rr,
                approvalRequired: ocppApprovalRequired,
              });
            }
          }}
        />
        {ocppDefaultsMutation.isSuccess && (
          <p className="text-sm text-success">{t('common.saved')}</p>
        )}
      </TabsContent>
      <TabsContent value="roaming" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.roaming')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.roamingDescription')}</p>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.roamingEnabled')}</Label>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={roamingEnabled}
                onClick={() => {
                  roamingMutation.mutate(!roamingEnabled);
                }}
                disabled={roamingMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${roamingEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${roamingEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="pnc" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.pnc')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.pncDescription')}</p>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.pncEnabled')}</Label>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={pncEnabled}
                onClick={() => {
                  pncToggleMutation.mutate(!pncEnabled);
                }}
                disabled={pncToggleMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${pncEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${pncEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>

            {pncEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="pnc-provider">{t('settings.pncProvider')}</Label>
                    <Select
                      id="pnc-provider"
                      value={pncProvider}
                      onChange={(e) => {
                        setPncProvider(e.target.value);
                      }}
                      className="h-9"
                    >
                      <option value="manual">{t('settings.pncProviderManual')}</option>
                      <option value="hubject">{t('settings.pncProviderHubject')}</option>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="pnc-warning-days">
                      {t('settings.pncExpirationWarningDays')}
                    </Label>
                    <Input
                      id="pnc-warning-days"
                      type="number"
                      min={1}
                      max={365}
                      value={pncWarningDays}
                      onChange={(e) => {
                        setPncWarningDays(e.target.value);
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="pnc-critical-days">
                      {t('settings.pncExpirationCriticalDays')}
                    </Label>
                    <Input
                      id="pnc-critical-days"
                      type="number"
                      min={1}
                      max={90}
                      value={pncCriticalDays}
                      onChange={(e) => {
                        setPncCriticalDays(e.target.value);
                      }}
                    />
                  </div>
                </div>

                {pncProvider === 'hubject' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-base-url">
                        {t('settings.pncHubjectBaseUrl')}
                      </Label>
                      <Input
                        id="pnc-hubject-base-url"
                        value={pncHubjectBaseUrl}
                        onChange={(e) => {
                          setPncHubjectBaseUrl(e.target.value);
                        }}
                        placeholder="https://open.plugncharge-test.hubject.com"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-client-id">
                        {t('settings.pncHubjectClientId')}
                      </Label>
                      <Input
                        id="pnc-hubject-client-id"
                        value={pncHubjectClientId}
                        onChange={(e) => {
                          setPncHubjectClientId(e.target.value);
                        }}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-client-secret">
                        {t('settings.pncHubjectClientSecret')}
                      </Label>
                      <PasswordInput
                        id="pnc-hubject-client-secret"
                        value={pncHubjectClientSecret}
                        onChange={(e) => {
                          setPncHubjectClientSecret(e.target.value);
                        }}
                        placeholder={
                          typeof pncSettings['pnc.hubject.clientSecretEnc'] === 'string' &&
                          pncSettings['pnc.hubject.clientSecretEnc'] !== ''
                            ? '********'
                            : ''
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-token-url">
                        {t('settings.pncHubjectTokenUrl')}
                      </Label>
                      <Input
                        id="pnc-hubject-token-url"
                        value={pncHubjectTokenUrl}
                        onChange={(e) => {
                          setPncHubjectTokenUrl(e.target.value);
                        }}
                        placeholder="https://hubject.b2clogin.com/.../oauth2/v2.0/token"
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-2">
                  <SaveButton
                    isPending={pncSaveMutation.isPending}
                    type="button"
                    onClick={() => {
                      pncSaveMutation.mutate({
                        provider: pncProvider,
                        hubjectBaseUrl: pncHubjectBaseUrl,
                        hubjectClientId: pncHubjectClientId,
                        hubjectClientSecret: pncHubjectClientSecret,
                        hubjectTokenUrl: pncHubjectTokenUrl,
                        expirationWarningDays: Number(pncWarningDays),
                        expirationCriticalDays: Number(pncCriticalDays),
                      });
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      pncTestMutation.mutate();
                    }}
                    disabled={pncTestMutation.isPending}
                  >
                    {pncTestMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t('settings.pncTestConnection')}
                  </Button>
                </div>
                {pncSaveMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.pncSaved')}</p>
                )}
                {pncSaveMutation.isError && (
                  <p className="text-sm text-destructive">{t('settings.pncSaveFailed')}</p>
                )}
                {pncTestMutation.isSuccess && (
                  <p className="text-sm text-green-600">{t('settings.pncTestSuccess')}</p>
                )}
                {pncTestMutation.isError && (
                  <p className="text-sm text-destructive">{t('settings.pncTestFailed')}</p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="reservation" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.reservation')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.reservationEnabled')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.reservationEnabledDesc')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={reservationEnabled}
                onClick={() => {
                  setReservationEnabled(!reservationEnabled);
                  reservationMutation.mutate(!reservationEnabled);
                }}
                disabled={reservationMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${reservationEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${reservationEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
            <div className="mt-4">
              <ReservationSettings settings={settings} />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="support" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.support')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.supportEnabled')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.supportEnabledDesc')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={supportEnabled}
                onClick={() => {
                  setSupportEnabled(!supportEnabled);
                  supportMutation.mutate(!supportEnabled);
                }}
                disabled={supportMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${supportEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${supportEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="fleet" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.fleet')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.fleetEnabled')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.fleetEnabledDesc')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={fleetEnabled}
                onClick={() => {
                  setFleetEnabled(!fleetEnabled);
                  fleetMutation.mutate(!fleetEnabled);
                }}
                disabled={fleetMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${fleetEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${fleetEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="guest" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.guestCharging')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.guestChargingEnabled')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.guestChargingEnabledDesc')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={guestChargingEnabled}
                onClick={() => {
                  setGuestChargingEnabled(!guestChargingEnabled);
                  guestChargingMutation.mutate(!guestChargingEnabled);
                }}
                disabled={guestChargingMutation.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${guestChargingEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${guestChargingEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="idling" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.idleGracePeriod')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.idlingDescription')}</p>
            <div className="grid gap-2 max-w-xs">
              <Label htmlFor="idling-grace-period">{t('settings.idleGracePeriodMinutes')}</Label>
              <Input
                id="idling-grace-period"
                type="number"
                min={0}
                step={1}
                value={idlingGracePeriod}
                onChange={(e) => {
                  setIdlingGracePeriod(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('settings.idleGracePeriodHelp')}</p>
            </div>
            <SaveButton
              isPending={idlingGracePeriodMutation.isPending}
              type="button"
              onClick={() => {
                const minutes = parseInt(idlingGracePeriod, 10);
                if (!isNaN(minutes) && minutes >= 0) {
                  idlingGracePeriodMutation.mutate(minutes);
                }
              }}
            />
            {idlingGracePeriodMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="session" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.sessionSettings')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.sessionDescription')}</p>
            <div className="grid gap-2 max-w-xs">
              <Label htmlFor="stale-session-timeout">
                {t('settings.staleSessionTimeoutHours')}
              </Label>
              <Input
                id="stale-session-timeout"
                type="number"
                min={0}
                step={1}
                value={staleSessionTimeout}
                onChange={(e) => {
                  setStaleSessionTimeout(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.staleSessionTimeoutHelp')}
              </p>
            </div>
            <SaveButton
              isPending={staleSessionTimeoutMutation.isPending}
              type="button"
              onClick={() => {
                const hours = parseInt(staleSessionTimeout, 10);
                if (!isNaN(hours) && hours >= 0) {
                  staleSessionTimeoutMutation.mutate(hours);
                }
              }}
            />
            {staleSessionTimeoutMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="pricing" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.pricingSettings')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.pricingDescription')}</p>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.splitBilling')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.splitBillingDesc')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={splitBillingEnabled}
                onClick={() => {
                  setSplitBillingEnabled((v) => !v);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${splitBillingEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${splitBillingEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pricing-display-format">{t('settings.displayFormat')}</Label>
              <p className="text-xs text-muted-foreground">{t('settings.displayFormatDesc')}</p>
              <Select
                id="pricing-display-format"
                value={pricingDisplayFormat}
                onChange={(e) => {
                  setPricingDisplayFormat(e.target.value);
                }}
              >
                <option value="standard">{t('settings.displayFormatStandard')}</option>
                <option value="compact">{t('settings.displayFormatCompact')}</option>
              </Select>
              <div className="rounded-md border bg-muted/50 px-3 py-2">
                <p className="text-xs font-medium text-muted-foreground mb-1">
                  {t('settings.displayFormatExample')}
                </p>
                <p className="text-sm">
                  {pricingDisplayFormat === 'compact'
                    ? '$0.25/kWh + $0.15/min + $2.00 session'
                    : 'Energy: $0.25/kWh | Time: $0.15/min | Session: $2.00 | Idle: $0.05/min | Tax: 8%'}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.pushDisplay')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.pushDisplayDesc')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={pushDisplayEnabled}
                onClick={() => {
                  setPushDisplayEnabled((v) => !v);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${pushDisplayEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${pushDisplayEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>

            <SaveButton
              isPending={pricingSettingsMutation.isPending}
              type="button"
              onClick={() => {
                pricingSettingsMutation.mutate({
                  splitBillingEnabled,
                  displayFormat: pricingDisplayFormat,
                  pushDisplayEnabled,
                });
              }}
            />
            {pricingSettingsMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="googleMaps" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.googleMaps')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.googleMapsDescription')}</p>

            <div className="grid gap-4 max-w-md">
              <div className="grid gap-2">
                <Label htmlFor="google-maps-api-key">{t('settings.googleMapsApiKey')}</Label>
                <PasswordInput
                  id="google-maps-api-key"
                  placeholder={t('settings.googleMapsApiKeyPlaceholder')}
                  value={googleMapsApiKey}
                  onChange={(e) => {
                    setGoogleMapsApiKey(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.googleMapsApiKeyHint')}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="google-maps-lat">{t('settings.googleMapsDefaultLat')}</Label>
                  <Input
                    id="google-maps-lat"
                    type="number"
                    step="0.0001"
                    min={-90}
                    max={90}
                    placeholder="39.8283"
                    value={googleMapsDefaultLat}
                    onChange={(e) => {
                      setGoogleMapsDefaultLat(e.target.value);
                    }}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="google-maps-lng">{t('settings.googleMapsDefaultLng')}</Label>
                  <Input
                    id="google-maps-lng"
                    type="number"
                    step="0.0001"
                    min={-180}
                    max={180}
                    placeholder="-98.5795"
                    value={googleMapsDefaultLng}
                    onChange={(e) => {
                      setGoogleMapsDefaultLng(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="google-maps-zoom">{t('settings.googleMapsDefaultZoom')}</Label>
                <Input
                  id="google-maps-zoom"
                  type="number"
                  min={1}
                  max={20}
                  placeholder="4"
                  value={googleMapsDefaultZoom}
                  onChange={(e) => {
                    setGoogleMapsDefaultZoom(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('settings.googleMapsZoomHint')}</p>
              </div>
            </div>

            <SaveButton
              isPending={googleMapsMutation.isPending}
              type="button"
              onClick={() => {
                googleMapsMutation.mutate({
                  apiKey: googleMapsApiKey.trim(),
                  defaultLat: googleMapsDefaultLat,
                  defaultLng: googleMapsDefaultLng,
                  defaultZoom: googleMapsDefaultZoom,
                });
              }}
            />
            {googleMapsMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
            {googleMapsMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.googleMapsSaveFailed')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="s3" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.s3')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.s3Description')}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="s3-bucket">{t('settings.s3Bucket')}</Label>
                <Input
                  id="s3-bucket"
                  value={s3Bucket}
                  onChange={(e) => {
                    setS3Bucket(e.target.value);
                  }}
                  placeholder="my-csms-attachments"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="s3-region">{t('settings.s3Region')}</Label>
                <Input
                  id="s3-region"
                  value={s3Region}
                  onChange={(e) => {
                    setS3Region(e.target.value);
                  }}
                  placeholder="us-east-1"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="s3-access-key">{t('settings.s3AccessKeyId')}</Label>
                <Input
                  id="s3-access-key"
                  value={s3AccessKeyId}
                  onChange={(e) => {
                    setS3AccessKeyId(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="s3-secret-key">{t('settings.s3SecretAccessKey')}</Label>
                <PasswordInput
                  id="s3-secret-key"
                  value={s3SecretAccessKey}
                  onChange={(e) => {
                    setS3SecretAccessKey(e.target.value);
                  }}
                  placeholder={
                    settings != null &&
                    typeof settings['s3.secretAccessKeyEnc'] === 'string' &&
                    settings['s3.secretAccessKeyEnc'] !== ''
                      ? '********'
                      : ''
                  }
                />
              </div>
            </div>

            <div className="flex gap-2">
              <SaveButton
                isPending={s3Mutation.isPending}
                type="button"
                disabled={
                  s3Bucket === '' ||
                  s3Region === '' ||
                  s3AccessKeyId === '' ||
                  s3SecretAccessKey === ''
                }
                onClick={() => {
                  s3Mutation.mutate({
                    bucket: s3Bucket,
                    region: s3Region,
                    accessKeyId: s3AccessKeyId,
                    secretAccessKey: s3SecretAccessKey,
                  });
                }}
              />
              <Button
                variant="outline"
                onClick={() => {
                  s3TestMutation.mutate();
                }}
                disabled={s3TestMutation.isPending}
              >
                <Send className="h-4 w-4" />
                {t('settings.s3Test')}
              </Button>
            </div>
            {s3Mutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.s3Saved')}</p>
            )}
            {s3Mutation.isError && (
              <p className="text-sm text-destructive">{t('settings.s3SaveFailed')}</p>
            )}
            {s3TestMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.s3TestSuccess')}</p>
            )}
            {s3TestMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.s3TestFailed')}</p>
            )}

            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => {
                  setS3PolicyOpen((prev) => !prev);
                }}
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${s3PolicyOpen ? 'rotate-180' : ''}`}
                />
                {t('settings.s3PolicyTitle')}
              </button>
              {s3PolicyOpen && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t('settings.s3PolicyDescription')}
                  </p>
                  <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
                    {`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::YOUR_BUCKET_NAME/*"
    }
  ]
}`}
                  </pre>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.s3BucketPrivateNote')}
                  </p>
                </div>
              )}
            </div>
            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => {
                  setS3CorsOpen((prev) => !prev);
                }}
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${s3CorsOpen ? 'rotate-180' : ''}`}
                />
                {t('settings.s3CorsTitle')}
              </button>
              {s3CorsOpen && (
                <div className="mt-3 space-y-2">
                  <p className="text-sm text-muted-foreground">{t('settings.s3CorsDescription')}</p>
                  <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">
                    {`[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedOrigins": ["YOUR_FRONTEND_ORIGIN"],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 300
  }
]`}
                  </pre>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="ftp" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.ftpServer')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.ftpServerDescription')}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ftp-host">{t('settings.ftpHost')}</Label>
                <Input
                  id="ftp-host"
                  value={ftpHost}
                  onChange={(e) => {
                    setFtpHost(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ftp-port">{t('settings.ftpPort')}</Label>
                <Input
                  id="ftp-port"
                  type="number"
                  value={ftpPort}
                  onChange={(e) => {
                    setFtpPort(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ftp-username">{t('settings.ftpUsername')}</Label>
                <Input
                  id="ftp-username"
                  value={ftpUsername}
                  onChange={(e) => {
                    setFtpUsername(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ftp-password">{t('settings.ftpPassword')}</Label>
                <PasswordInput
                  id="ftp-password"
                  value={ftpPassword}
                  onChange={(e) => {
                    setFtpPassword(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ftp-path">{t('settings.ftpPath')}</Label>
                <Input
                  id="ftp-path"
                  value={ftpPath}
                  onChange={(e) => {
                    setFtpPath(e.target.value);
                  }}
                />
              </div>
            </div>

            <SaveButton
              isPending={ftpMutation.isPending}
              type="button"
              onClick={() => {
                ftpMutation.mutate({
                  host: ftpHost,
                  port: ftpPort,
                  username: ftpUsername,
                  password: ftpPassword,
                  path: ftpPath,
                });
              }}
            />
            {ftpMutation.isSuccess && (
              <p className="text-sm text-green-600">{t('settings.ftpSaved')}</p>
            )}
            {ftpMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.ftpSaveFailed')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="sentry" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.sentry')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.sentryDescription')}</p>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>{t('settings.sentryEnabled')}</Label>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sentryEnabled}
                onClick={() => {
                  setSentryEnabled(!sentryEnabled);
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${sentryEnabled ? 'bg-primary' : 'bg-muted'}`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform ${sentryEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                />
              </button>
            </div>

            <div className="grid gap-4 max-w-md">
              <div className="grid gap-2">
                <Label htmlFor="sentry-dsn">{t('settings.sentryDsn')}</Label>
                <Input
                  id="sentry-dsn"
                  placeholder="https://examplePublicKey@o0.ingest.sentry.io/0"
                  value={sentryDsn}
                  onChange={(e) => {
                    setSentryDsn(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('settings.sentryDsnHint')}</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="sentry-environment">{t('settings.sentryEnvironment')}</Label>
                <Input
                  id="sentry-environment"
                  placeholder="production"
                  value={sentryEnvironment}
                  onChange={(e) => {
                    setSentryEnvironment(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('settings.sentryEnvironmentHint')}
                </p>
              </div>
            </div>

            <SaveButton
              isPending={sentryMutation.isPending}
              type="button"
              onClick={() => {
                sentryMutation.mutate({
                  enabled: sentryEnabled,
                  dsn: sentryDsn.trim(),
                  environment: sentryEnvironment.trim(),
                });
              }}
            />
            {sentryMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
            {sentryMutation.isError && (
              <p className="text-sm text-destructive">{t('settings.sentrySaveFailed')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
