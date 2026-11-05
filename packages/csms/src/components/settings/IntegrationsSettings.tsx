// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { AutochargeSettings } from '@/components/settings/AutochargeSettings';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { SaveButton } from '@/components/save-button';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmToggle } from '@/components/ui/confirm-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';
import { ReservationSettings } from '@/components/settings/ReservationSettings';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { StationMessageSettings } from '@/components/settings/StationMessageSettings';
import { PncLocalCaSection } from '@/components/settings/PncLocalCaSection';
import { FleetCreditReservationSettings } from '@/components/settings/FleetCreditReservationSettings';
import { BusDepotSystemsSettings } from './BusDepotSystemsSettings';
import { SimProvidersSettings } from '@/components/settings/SimProvidersSettings';
import { OcppDataPlanSettings } from '@/components/settings/OcppDataPlanSettings';
import { StorageSettings, STORAGE_TAB_PARAM } from '@/components/settings/StorageSettings';
import { isEditedField, useLoadedValues } from '@/hooks/use-loaded-values';

// A bus depot system opened in place belongs to its sub tab; another sub tab drops it.
const SUB_TAB_CLEARS = ['depotSystem', 'depotTab', STORAGE_TAB_PARAM];

/** A setter for one field of a card's values. */
function field<T extends object, K extends keyof T>(
  set: Dispatch<SetStateAction<T>>,
  key: K,
): (value: T[K]) => void {
  return (value) => {
    set((prev) => ({ ...prev, [key]: value }));
  };
}

interface IntegrationsSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function IntegrationsSettings({ settings }: IntegrationsSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [subTabParam, setIntegrationsSubTab] = useTab('ocppDefaults', 'sub', SUB_TAB_CLEARS);
  // The Storage tab had the id s3 (S3 Bucket); old links still open it.
  const integrationsSubTab = subTabParam === 's3' ? 'storage' : subTabParam;
  // Once opened, the Storage tab stays mounted, so its unsaved edits survive a sub tab switch.
  const [storageVisited, setStorageVisited] = useState(integrationsSubTab === 'storage');
  if (integrationsSubTab === 'storage' && !storageVisited) setStorageVisited(true);

  const str = (key: string): string => {
    const v = settings?.[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const hostList = (v: unknown): string =>
    Array.isArray(v) ? v.filter((h) => typeof h === 'string').join('\n') : '';
  const numberText = (key: string, fallback: string): string => {
    const v = settings?.[key];
    return v != null ? Number(v).toString() : fallback;
  };
  const textOr = (key: string, fallback: string): string => {
    const v = settings?.[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : fallback;
  };

  // Each card holds the stored values until it is edited: a settings reload
  // (another card's save, window focus) replaces a card only while it is clean.

  // FTP state
  const [ftp, setFtp, takeFtpLoad, ftpTaken] = useLoadedValues({
    host: str('ftp.host'),
    port: str('ftp.port'),
    username: str('ftp.username'),
    password: str('ftp.passwordEnc'),
    path: str('ftp.path'),
  });
  const {
    host: ftpHost,
    port: ftpPort,
    username: ftpUsername,
    password: ftpPassword,
    path: ftpPath,
  } = ftp;
  const setFtpHost = field(setFtp, 'host');
  const setFtpPort = field(setFtp, 'port');
  const setFtpUsername = field(setFtp, 'username');
  const setFtpPassword = field(setFtp, 'password');
  const setFtpPath = field(setFtp, 'path');

  // Feature toggles: each saves at once, and shows the new state while its save runs.
  const [features, setFeatures] = useLoadedValues({
    reservation: settings?.['reservation.enabled'] !== false,
    support: settings?.['support.enabled'] !== false,
    fleet: settings?.['fleet.enabled'] !== false,
    fleetCharging: settings?.['fleetCharging.enabled'] === true,
    guest: settings?.['guest.enabled'] !== false,
  });
  const {
    reservation: reservationEnabled,
    support: supportEnabled,
    fleet: fleetEnabled,
    fleetCharging: fleetChargingEnabled,
    guest: guestChargingEnabled,
  } = features;
  const setReservationEnabled = field(setFeatures, 'reservation');
  const setSupportEnabled = field(setFeatures, 'support');
  const setFleetEnabled = field(setFeatures, 'fleet');
  const setFleetChargingEnabled = field(setFeatures, 'fleetCharging');
  const setGuestChargingEnabled = field(setFeatures, 'guest');

  const storedGuestStarts = settings?.['guest.startsPerIpPerHour'];
  const storedGuestDeclines = settings?.['guest.declinesPerIpPerHour'];
  const [guestLimits, setGuestLimits, takeGuestLimitsLoad] = useLoadedValues({
    starts: typeof storedGuestStarts === 'number' ? String(storedGuestStarts) : '30',
    declines: typeof storedGuestDeclines === 'number' ? String(storedGuestDeclines) : '5',
  });
  const { starts: guestStartsPerIp, declines: guestDeclinesPerIp } = guestLimits;
  const setGuestStartsPerIp = field(setGuestLimits, 'starts');
  const setGuestDeclinesPerIp = field(setGuestLimits, 'declines');

  // Idling and session
  const [idling, setIdling, takeIdlingLoad] = useLoadedValues({
    gracePeriod: numberText('idling.gracePeriodMinutes', '30'),
  });
  const idlingGracePeriod = idling.gracePeriod;
  const setIdlingGracePeriod = field(setIdling, 'gracePeriod');
  const [staleSession, setStaleSession, takeStaleSessionLoad] = useLoadedValues({
    hours: numberText('session.staleTimeoutHours', '24'),
  });
  const staleSessionTimeout = staleSession.hours;
  const setStaleSessionTimeout = field(setStaleSession, 'hours');
  const [evConnection, setEvConnection, takeEvConnectionLoad] = useLoadedValues({
    seconds: numberText('session.evConnectionTimeoutSeconds', '180'),
  });
  const evConnectionTimeout = evConnection.seconds;
  const setEvConnectionTimeout = field(setEvConnection, 'seconds');

  // Pricing: on unless stored as false, as the server reads it (isSplitBillingEnabled).
  const [pricing, setPricing, takePricingLoad] = useLoadedValues({
    splitBilling: settings?.['pricing.splitBillingEnabled'] !== false,
  });
  const splitBillingEnabled = pricing.splitBilling;
  const setSplitBillingEnabled = field(setPricing, 'splitBilling');

  // Google Maps
  const storedMapsKey = settings?.['googleMaps.apiKeyEnc'];
  const [maps, setMaps, takeMapsLoad, mapsTaken] = useLoadedValues({
    apiKey: typeof storedMapsKey === 'string' ? storedMapsKey : '',
    lat: textOr('googleMaps.defaultLat', '39.8283'),
    lng: textOr('googleMaps.defaultLng', '-98.5795'),
    zoom: textOr('googleMaps.defaultZoom', '4'),
  });
  const {
    apiKey: googleMapsApiKey,
    lat: googleMapsDefaultLat,
    lng: googleMapsDefaultLng,
    zoom: googleMapsDefaultZoom,
  } = maps;
  const setGoogleMapsApiKey = field(setMaps, 'apiKey');
  const setGoogleMapsDefaultLat = field(setMaps, 'lat');
  const setGoogleMapsDefaultLng = field(setMaps, 'lng');
  const setGoogleMapsDefaultZoom = field(setMaps, 'zoom');

  // Sentry
  const storedSentryDsn = settings?.['sentry.dsn'];
  const storedSentryEnv = settings?.['sentry.environment'];
  const [sentry, setSentry, takeSentryLoad] = useLoadedValues({
    enabled: settings?.['sentry.enabled'] === true,
    dsn: typeof storedSentryDsn === 'string' ? storedSentryDsn : '',
    environment: typeof storedSentryEnv === 'string' ? storedSentryEnv : 'production',
  });
  const { enabled: sentryEnabled, dsn: sentryDsn, environment: sentryEnvironment } = sentry;
  const setSentryEnabled = field(setSentry, 'enabled');
  const setSentryDsn = field(setSentry, 'dsn');
  const setSentryEnvironment = field(setSentry, 'environment');

  // OCPP defaults
  const [ocppDefaults, setOcppDefaults, takeOcppDefaultsLoad] = useLoadedValues({
    connectionTimeout: numberText('ocpp.connectionTimeout', '120'),
    resetRetries: numberText('ocpp.resetRetries', '3'),
    approvalRequired: settings?.['ocpp.registrationPolicy'] !== 'open',
  });
  const {
    connectionTimeout: ocppConnectionTimeout,
    resetRetries: ocppResetRetries,
    approvalRequired: ocppApprovalRequired,
  } = ocppDefaults;
  const setOcppConnectionTimeout = field(setOcppDefaults, 'connectionTimeout');
  const setOcppResetRetries = field(setOcppDefaults, 'resetRetries');
  const setOcppApprovalRequired = field(setOcppDefaults, 'approvalRequired');

  // PnC
  const { data: pncSettings } = useQuery({
    queryKey: ['pnc-settings'],
    queryFn: () => api.get<Record<string, unknown>>('/v1/pnc/settings'),
  });

  const pncEnabled = pncSettings != null && pncSettings['pnc.enabled'] === true;
  const pncStr = (key: string): string => {
    const v = pncSettings?.[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const [pnc, setPnc, takePncLoad, pncTaken] = useLoadedValues({
    provider: pncStr('pnc.provider') || 'manual',
    hubjectBaseUrl: pncStr('pnc.hubject.baseUrl'),
    hubjectClientId: pncStr('pnc.hubject.clientId'),
    hubjectClientSecret: pncStr('pnc.hubject.clientSecretEnc'),
    hubjectTokenUrl: pncStr('pnc.hubject.tokenUrl'),
    warningDays: pncStr('pnc.expirationWarningDays') || '30',
    criticalDays: pncStr('pnc.expirationCriticalDays') || '7',
    ocspAllowedHosts: hostList(pncSettings?.['pnc.ocsp.allowedPrivateHosts']),
    emaidCountry: pncStr('pnc.local.emaidCountry'),
    emaidProviderId: pncStr('pnc.local.emaidProviderId'),
  });
  const {
    provider: pncProvider,
    hubjectBaseUrl: pncHubjectBaseUrl,
    hubjectClientId: pncHubjectClientId,
    hubjectClientSecret: pncHubjectClientSecret,
    hubjectTokenUrl: pncHubjectTokenUrl,
    warningDays: pncWarningDays,
    criticalDays: pncCriticalDays,
    ocspAllowedHosts: pncOcspAllowedHosts,
    emaidCountry: pncEmaidCountry,
    emaidProviderId: pncEmaidProviderId,
  } = pnc;
  const setPncProvider = field(setPnc, 'provider');
  const setPncHubjectBaseUrl = field(setPnc, 'hubjectBaseUrl');
  const setPncHubjectClientId = field(setPnc, 'hubjectClientId');
  const setPncHubjectClientSecret = field(setPnc, 'hubjectClientSecret');
  const setPncHubjectTokenUrl = field(setPnc, 'hubjectTokenUrl');
  const setPncWarningDays = field(setPnc, 'warningDays');
  const setPncCriticalDays = field(setPnc, 'criticalDays');
  const setPncOcspAllowedHosts = field(setPnc, 'ocspAllowedHosts');
  const setPncEmaidCountry = field(setPnc, 'emaidCountry');
  const setPncEmaidProviderId = field(setPnc, 'emaidProviderId');

  const roamingEnabled = settings != null && settings['roaming.enabled'] === true;

  // Mutations
  const ftpMutation = useMutation({
    mutationFn: (vals: {
      host: string;
      port: string;
      username: string;
      password?: string;
      path: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/ftp.host', { value: vals.host }),
        api.put('/v1/settings/ftp.port', { value: Number(vals.port) }),
        api.put('/v1/settings/ftp.username', { value: vals.username }),
        ...(vals.password !== undefined
          ? [api.put('/v1/settings/ftp.passwordEnc', { value: vals.password })]
          : []),
        api.put('/v1/settings/ftp.path', { value: vals.path }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
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

  // A failed save puts the switch back and says why.
  const fleetMutation = useMutation({
    mutationFn: (enabled: boolean) => api.put('/v1/settings/fleet.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err: unknown, enabled: boolean) => {
      setFleetEnabled(!enabled);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
    },
  });

  const fleetChargingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.put('/v1/settings/fleetCharging.enabled', { value: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['site-charging-plan'] });
    },
    onError: (err: unknown, enabled: boolean) => {
      setFleetChargingEnabled(!enabled);
      toast({ title: getErrorMessage(err, t), variant: 'destructive' });
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
      connectionTimeout: number;
      resetRetries: number;
      approvalRequired: boolean;
    }) =>
      Promise.all([
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

  const guestLimitsMutation = useMutation({
    mutationFn: async (limits: { starts: number; declines: number }) => {
      await api.put('/v1/settings/guest.startsPerIpPerHour', { value: limits.starts });
      await api.put('/v1/settings/guest.declinesPerIpPerHour', { value: limits.declines });
    },
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

  const evConnectionTimeoutMutation = useMutation({
    mutationFn: (seconds: number) =>
      api.put('/v1/settings/session.evConnectionTimeoutSeconds', { value: seconds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const googleMapsMutation = useMutation({
    mutationFn: (vals: {
      apiKey?: string;
      defaultLat: string;
      defaultLng: string;
      defaultZoom: string;
    }) =>
      Promise.all([
        ...(vals.apiKey !== undefined
          ? [api.put('/v1/settings/googleMaps.apiKeyEnc', { value: vals.apiKey })]
          : []),
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
      hubjectClientSecret?: string;
      hubjectTokenUrl: string;
      expirationWarningDays: number;
      expirationCriticalDays: number;
      ocspAllowedPrivateHosts: string[];
      localEmaidCountry?: string;
      localEmaidProviderId?: string;
    }) => api.put('/v1/pnc/settings', vals),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pnc-settings'] });
    },
  });

  const pncTestMutation = useMutation({
    mutationFn: () => api.post('/v1/pnc/settings/test-provider', {}),
  });

  const pricingSettingsMutation = useMutation({
    mutationFn: (vals: { splitBillingEnabled: boolean }) =>
      api.put('/v1/settings/pricing.splitBillingEnabled', { value: vals.splitBillingEnabled }),
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
        <TabsTrigger value="autocharge">{t('settings.autocharge')}</TabsTrigger>
        <TabsTrigger value="reservation">{t('settings.reservation')}</TabsTrigger>
        <TabsTrigger value="support">{t('settings.support')}</TabsTrigger>
        <TabsTrigger value="fleet">{t('settings.fleet')}</TabsTrigger>
        <TabsTrigger value="depot-systems">{t('depotSystems.tab')}</TabsTrigger>
        <TabsTrigger value="guest">{t('settings.guestCharging')}</TabsTrigger>
        <TabsTrigger value="idling">{t('settings.idling')}</TabsTrigger>
        <TabsTrigger value="session">{t('settings.session')}</TabsTrigger>
        <TabsTrigger value="pricing">{t('settings.pricingSettings')}</TabsTrigger>
        <TabsTrigger value="messages">{t('settings.messagesTab')}</TabsTrigger>
        <TabsTrigger value="simProviders">{t('settings.sim.tab')}</TabsTrigger>
        <TabsTrigger value="storage">{t('settings.storage.title')}</TabsTrigger>
        <TabsTrigger value="ftp">{t('settings.ftpServer')}</TabsTrigger>
        <TabsTrigger value="googleMaps">{t('settings.googleMaps')}</TabsTrigger>
        <TabsTrigger value="sentry">{t('settings.sentry')}</TabsTrigger>
      </TabsList>
      <TabsContent value="ocppDefaults" className="mt-4 space-y-6">
        <OcppDataPlanSettings settings={settings} />

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
                <ConfirmToggle
                  aria-label={t('settings.ocppApprovalRequired')}
                  label={t('settings.ocppApprovalRequired')}
                  size="lg"
                  checked={ocppApprovalRequired}
                  onCheckedChange={() => {
                    setOcppApprovalRequired(!ocppApprovalRequired);
                  }}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <SaveButton
          isPending={ocppDefaultsMutation.isPending}
          type="button"
          onClick={() => {
            const ct = parseInt(ocppConnectionTimeout, 10);
            const rr = parseInt(ocppResetRetries, 10);
            if (!isNaN(ct) && !isNaN(rr)) {
              ocppDefaultsMutation.mutate(
                {
                  connectionTimeout: ct,
                  resetRetries: rr,
                  approvalRequired: ocppApprovalRequired,
                },
                {
                  onSuccess: () => {
                    takeOcppDefaultsLoad(ocppDefaults);
                  },
                },
              );
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
                <Label className="leading-6">{t('settings.roamingEnabled')}</Label>
              </div>
              <ConfirmToggle
                aria-label={t('settings.roamingEnabled')}
                label={t('settings.roamingEnabled')}
                offDescription={t('settings.roamingOffDescription')}
                size="lg"
                checked={roamingEnabled}
                onCheckedChange={() => {
                  roamingMutation.mutate(!roamingEnabled);
                }}
                disabled={roamingMutation.isPending}
              />
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
                <Label className="leading-6">{t('settings.pncEnabled')}</Label>
              </div>
              <ConfirmToggle
                aria-label={t('settings.pncEnabled')}
                label={t('settings.pncEnabled')}
                offDescription={t('settings.pncOffDescription')}
                size="lg"
                checked={pncEnabled}
                onCheckedChange={() => {
                  pncToggleMutation.mutate(!pncEnabled);
                }}
                disabled={pncToggleMutation.isPending}
              />
            </div>

            {pncEnabled && (
              <>
                <div className="grid gap-4 sm:grid-cols-2 items-start">
                  <div className="space-y-2">
                    <Label htmlFor="pnc-provider" className="leading-6">
                      {t('settings.pncProvider')}
                    </Label>
                    <Select
                      id="pnc-provider"
                      value={pncProvider}
                      onChange={(e) => {
                        setPncProvider(e.target.value);
                      }}
                    >
                      <option value="manual">{t('settings.pncProviderManual')}</option>
                      <option value="hubject">{t('settings.pncProviderHubject')}</option>
                      <option value="local">{t('settings.pncProviderLocal')}</option>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="pnc-warning-days" className="leading-6">
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
                    <Label htmlFor="pnc-critical-days" className="leading-6">
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

                <div className="space-y-2">
                  <Label htmlFor="pnc-ocsp-allowed-hosts" className="leading-6">
                    {t('settings.pncOcspAllowedPrivateHosts')}
                  </Label>
                  <Textarea
                    id="pnc-ocsp-allowed-hosts"
                    rows={3}
                    value={pncOcspAllowedHosts}
                    onChange={(e) => {
                      setPncOcspAllowedHosts(e.target.value);
                    }}
                    placeholder="ocsp.internal.example"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.pncOcspAllowedPrivateHostsHint')}
                  </p>
                </div>

                {pncProvider === 'local' && (
                  <PncLocalCaSection
                    emaidCountry={pncEmaidCountry}
                    emaidProviderId={pncEmaidProviderId}
                    onEmaidCountryChange={setPncEmaidCountry}
                    onEmaidProviderIdChange={setPncEmaidProviderId}
                  />
                )}

                {pncProvider === 'hubject' && (
                  <div className="grid gap-4 sm:grid-cols-2 items-start">
                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-base-url" className="leading-6">
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
                      <Label htmlFor="pnc-hubject-client-id" className="leading-6">
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
                      <Label htmlFor="pnc-hubject-client-secret" className="leading-6">
                        {t('settings.pncHubjectClientSecret')}
                      </Label>
                      <PasswordInput
                        id="pnc-hubject-client-secret"
                        value={pncHubjectClientSecret}
                        onChange={(e) => {
                          setPncHubjectClientSecret(e.target.value);
                        }}
                        placeholder={
                          pncSettings['pnc.hubject.clientSecretConfigured'] === true
                            ? '********'
                            : ''
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="pnc-hubject-token-url" className="leading-6">
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

                <div className="flex justify-start gap-2">
                  <SaveButton
                    isPending={pncSaveMutation.isPending}
                    type="button"
                    onClick={() => {
                      pncSaveMutation.mutate(
                        {
                          provider: pncProvider,
                          hubjectBaseUrl: pncHubjectBaseUrl,
                          hubjectClientId: pncHubjectClientId,
                          // Sent only when edited in this form: the GET returns
                          // the stored secret only with settings.system:read
                          // (P12), and a secret another user rotated since this
                          // form loaded is not put back.
                          ...(isEditedField(pnc, pncTaken, 'hubjectClientSecret')
                            ? { hubjectClientSecret: pncHubjectClientSecret }
                            : {}),
                          hubjectTokenUrl: pncHubjectTokenUrl,
                          expirationWarningDays: Number(pncWarningDays),
                          expirationCriticalDays: Number(pncCriticalDays),
                          ocspAllowedPrivateHosts: pncOcspAllowedHosts
                            .split(/[\s,]+/)
                            .map((h) => h.trim())
                            .filter((h) => h !== ''),
                          ...(pncProvider === 'local'
                            ? {
                                localEmaidCountry: pncEmaidCountry,
                                localEmaidProviderId: pncEmaidProviderId,
                              }
                            : {}),
                        },
                        {
                          onSuccess: () => {
                            takePncLoad(pnc);
                          },
                        },
                      );
                    }}
                  />
                  <Button
                    variant="outline"
                    onClick={() => {
                      pncTestMutation.mutate();
                    }}
                    disabled={pncTestMutation.isPending}
                  >
                    {pncTestMutation.isPending && <Spinner className="h-4 w-4" />}
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
                <Label className="leading-6">{t('settings.reservationEnabled')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.reservationEnabledDesc')}
                </p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.reservationEnabled')}
                label={t('settings.reservationEnabled')}
                size="lg"
                checked={reservationEnabled}
                onCheckedChange={() => {
                  setReservationEnabled(!reservationEnabled);
                  reservationMutation.mutate(!reservationEnabled);
                }}
                disabled={reservationMutation.isPending}
              />
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
                <Label className="leading-6">{t('settings.supportEnabled')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.supportEnabledDesc')}</p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.supportEnabled')}
                label={t('settings.supportEnabled')}
                size="lg"
                checked={supportEnabled}
                onCheckedChange={() => {
                  setSupportEnabled(!supportEnabled);
                  supportMutation.mutate(!supportEnabled);
                }}
                disabled={supportMutation.isPending}
              />
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
                <Label className="leading-6">{t('settings.fleetEnabled')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.fleetEnabledDesc')}</p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.fleetEnabled')}
                label={t('settings.fleetEnabled')}
                size="lg"
                checked={fleetEnabled}
                onCheckedChange={() => {
                  setFleetEnabled(!fleetEnabled);
                  fleetMutation.mutate(!fleetEnabled);
                }}
                disabled={fleetMutation.isPending}
              />
            </div>
            <div className="mt-4 flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="leading-6">{t('settings.fleetChargingEnabled')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.fleetChargingEnabledDesc')}
                </p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.fleetChargingEnabled')}
                label={t('settings.fleetChargingEnabled')}
                offDescription={t('settings.fleetChargingEnabledOff')}
                size="lg"
                checked={fleetChargingEnabled}
                onCheckedChange={() => {
                  setFleetChargingEnabled(!fleetChargingEnabled);
                  fleetChargingMutation.mutate(!fleetChargingEnabled);
                }}
                disabled={fleetChargingMutation.isPending}
              />
            </div>
            <div className="mt-4">
              <FleetCreditReservationSettings settings={settings} />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="depot-systems" className="mt-4">
        <BusDepotSystemsSettings settings={settings} />
      </TabsContent>
      <TabsContent value="autocharge" className="mt-4">
        <AutochargeSettings settings={settings} />
      </TabsContent>
      <TabsContent value="guest" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.guestCharging')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label className="leading-6">{t('settings.guestChargingEnabled')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('settings.guestChargingEnabledDesc')}
                </p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.guestChargingEnabled')}
                label={t('settings.guestChargingEnabled')}
                size="lg"
                checked={guestChargingEnabled}
                onCheckedChange={() => {
                  setGuestChargingEnabled(!guestChargingEnabled);
                  guestChargingMutation.mutate(!guestChargingEnabled);
                }}
                disabled={guestChargingMutation.isPending}
              />
            </div>
            <div className="mt-4 space-y-4">
              <p className="text-sm text-muted-foreground">
                {t('settings.guestLimitsDescription')}
              </p>
              <div className="grid gap-4 sm:grid-cols-2 items-start">
                <div className="grid gap-2">
                  <Label htmlFor="guest-starts-per-ip">
                    {t('settings.guestStartsPerIpPerHour')}
                  </Label>
                  <Input
                    id="guest-starts-per-ip"
                    type="number"
                    min={0}
                    max={10000}
                    step={1}
                    value={guestStartsPerIp}
                    onChange={(e) => {
                      setGuestStartsPerIp(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.guestStartsPerIpPerHourHelp')}
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="guest-declines-per-ip">
                    {t('settings.guestDeclinesPerIpPerHour')}
                  </Label>
                  <Input
                    id="guest-declines-per-ip"
                    type="number"
                    min={0}
                    max={10000}
                    step={1}
                    value={guestDeclinesPerIp}
                    onChange={(e) => {
                      setGuestDeclinesPerIp(e.target.value);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('settings.guestDeclinesPerIpPerHourHelp')}
                  </p>
                </div>
              </div>
              <SaveButton
                isPending={guestLimitsMutation.isPending}
                type="button"
                onClick={() => {
                  const starts = Number(guestStartsPerIp);
                  const declines = Number(guestDeclinesPerIp);
                  const valid = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 10000;
                  if (valid(starts) && valid(declines)) {
                    guestLimitsMutation.mutate(
                      { starts, declines },
                      {
                        onSuccess: () => {
                          takeGuestLimitsLoad(guestLimits);
                        },
                      },
                    );
                  }
                }}
              />
              {guestLimitsMutation.isSuccess && (
                <p className="text-sm text-success">{t('common.saved')}</p>
              )}
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
            <div className="grid justify-end gap-2 max-w-xs">
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
                  idlingGracePeriodMutation.mutate(minutes, {
                    onSuccess: () => {
                      takeIdlingLoad(idling);
                    },
                  });
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
                  staleSessionTimeoutMutation.mutate(hours, {
                    onSuccess: () => {
                      takeStaleSessionLoad(staleSession);
                    },
                  });
                }
              }}
            />
            {staleSessionTimeoutMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
            <div className="grid gap-2 max-w-xs">
              <Label htmlFor="ev-connection-timeout">
                {t('settings.evConnectionTimeoutSeconds')}
              </Label>
              <Input
                id="ev-connection-timeout"
                type="number"
                min={1}
                step={1}
                value={evConnectionTimeout}
                onChange={(e) => {
                  setEvConnectionTimeout(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.evConnectionTimeoutHelp')}
              </p>
            </div>
            <SaveButton
              isPending={evConnectionTimeoutMutation.isPending}
              type="button"
              onClick={() => {
                const seconds = parseInt(evConnectionTimeout, 10);
                if (!isNaN(seconds) && seconds >= 1) {
                  evConnectionTimeoutMutation.mutate(seconds, {
                    onSuccess: () => {
                      takeEvConnectionLoad(evConnection);
                    },
                  });
                }
              }}
            />
            {evConnectionTimeoutMutation.isSuccess && (
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
                <Label className="leading-6">{t('settings.splitBilling')}</Label>
                <p className="text-xs text-muted-foreground">{t('settings.splitBillingDesc')}</p>
              </div>
              <ConfirmToggle
                aria-label={t('settings.splitBilling')}
                label={t('settings.splitBilling')}
                size="lg"
                checked={splitBillingEnabled}
                onCheckedChange={() => {
                  setSplitBillingEnabled(!splitBillingEnabled);
                }}
              />
            </div>

            <SaveButton
              isPending={pricingSettingsMutation.isPending}
              type="button"
              onClick={() => {
                pricingSettingsMutation.mutate(
                  { splitBillingEnabled },
                  {
                    onSuccess: () => {
                      takePricingLoad(pricing);
                    },
                  },
                );
              }}
            />
            {pricingSettingsMutation.isSuccess && (
              <p className="text-sm text-success">{t('common.saved')}</p>
            )}
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="messages" className="mt-4">
        <StationMessageSettings settings={settings} />
      </TabsContent>
      <TabsContent value="simProviders" className="mt-4">
        <SimProvidersSettings />
      </TabsContent>
      <TabsContent value="googleMaps" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.googleMaps')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.googleMapsDescription')}</p>

            <div className="grid gap-6 lg:grid-cols-2">
              <div className="grid gap-4">
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
                  <div className="grid gap-2">
                    <Label htmlFor="google-maps-lat">{t('settings.googleMapsDefaultLat')}</Label>
                    <DecimalInput
                      id="google-maps-lat"
                      placeholder="39.8283"
                      value={googleMapsDefaultLat}
                      onChange={setGoogleMapsDefaultLat}
                      allowNegative
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="google-maps-lng">{t('settings.googleMapsDefaultLng')}</Label>
                    <DecimalInput
                      id="google-maps-lng"
                      placeholder="-98.5795"
                      value={googleMapsDefaultLng}
                      onChange={setGoogleMapsDefaultLng}
                      allowNegative
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
                  <p className="text-xs text-muted-foreground">
                    {t('settings.googleMapsZoomHint')}
                  </p>
                </div>
              </div>

              <GoogleMapPicker
                latitude={googleMapsDefaultLat}
                longitude={googleMapsDefaultLng}
                onLocationChange={(lat, lng) => {
                  setGoogleMapsDefaultLat(lat);
                  setGoogleMapsDefaultLng(lng);
                }}
              />
            </div>

            <SaveButton
              isPending={googleMapsMutation.isPending}
              type="button"
              onClick={() => {
                googleMapsMutation.mutate(
                  {
                    ...(isEditedField(maps, mapsTaken, 'apiKey')
                      ? { apiKey: googleMapsApiKey.trim() }
                      : {}),
                    defaultLat: googleMapsDefaultLat,
                    defaultLng: googleMapsDefaultLng,
                    defaultZoom: googleMapsDefaultZoom,
                  },
                  {
                    onSuccess: () => {
                      takeMapsLoad(maps);
                    },
                  },
                );
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
      <TabsContent value="storage" className="mt-4" keepMounted={storageVisited}>
        <StorageSettings settings={settings} />
      </TabsContent>
      <TabsContent value="ftp" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle>{t('settings.ftpServer')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('settings.ftpServerDescription')}</p>

            <div className="grid gap-4 sm:grid-cols-2 items-start">
              <div className="space-y-2">
                <Label htmlFor="ftp-host" className="leading-6">
                  {t('settings.ftpHost')}
                </Label>
                <Input
                  id="ftp-host"
                  value={ftpHost}
                  onChange={(e) => {
                    setFtpHost(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ftp-port" className="leading-6">
                  {t('settings.ftpPort')}
                </Label>
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
                <Label htmlFor="ftp-username" className="leading-6">
                  {t('settings.ftpUsername')}
                </Label>
                <Input
                  id="ftp-username"
                  value={ftpUsername}
                  onChange={(e) => {
                    setFtpUsername(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="ftp-password" className="leading-6">
                  {t('settings.ftpPassword')}
                </Label>
                <PasswordInput
                  id="ftp-password"
                  value={ftpPassword}
                  onChange={(e) => {
                    setFtpPassword(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="ftp-path" className="leading-6">
                  {t('settings.ftpPath')}
                </Label>
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
                ftpMutation.mutate(
                  {
                    host: ftpHost,
                    port: ftpPort,
                    username: ftpUsername,
                    // An untouched password is left out, so a password another
                    // user rotated since this form loaded is not put back.
                    ...(isEditedField(ftp, ftpTaken, 'password') ? { password: ftpPassword } : {}),
                    path: ftpPath,
                  },
                  {
                    onSuccess: () => {
                      takeFtpLoad(ftp);
                    },
                  },
                );
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
                <Label className="leading-6">{t('settings.sentryEnabled')}</Label>
              </div>
              <ConfirmToggle
                aria-label={t('settings.sentryEnabled')}
                label={t('settings.sentryEnabled')}
                size="lg"
                checked={sentryEnabled}
                onCheckedChange={() => {
                  setSentryEnabled(!sentryEnabled);
                }}
              />
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
                sentryMutation.mutate(
                  {
                    enabled: sentryEnabled,
                    dsn: sentryDsn.trim(),
                    environment: sentryEnvironment.trim(),
                  },
                  {
                    onSuccess: () => {
                      takeSentryLoad(sentry);
                    },
                  },
                );
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
