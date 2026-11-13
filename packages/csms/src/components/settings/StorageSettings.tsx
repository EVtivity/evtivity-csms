// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Info, Send } from 'lucide-react';
import { useTab } from '@/hooks/use-tab';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible } from '@/components/ui/collapsible';
import { CopyButton } from '@/components/ui/copy-button';
import { api, ApiError } from '@/lib/api';
import { PORTAL_BASE_URL } from '@/lib/config';
import {
  R2_SETUP_DOCS_URL,
  S3_COMPATIBLE_SETUP_DOCS_URL,
  STORAGE_ACCESS_ACTIONS,
  buildS3CorsExample,
  storageBrowserOrigins,
} from '@/lib/s3-cors-example';
import {
  AWS_S3_REGIONS,
  R2_JURISDICTIONS,
  STORAGE_TABS,
  WASABI_REGIONS,
  isR2AccountId,
  parseR2Endpoint,
  providerOfTab,
  r2Endpoint,
  storageProviderOf,
  storageTabOf,
  storageTabParam,
  storedEndpointForm,
  wasabiEndpoint,
  wasabiRegionOf,
  type R2Jurisdiction,
  type StorageProvider,
  type StorageRegion,
  type StorageTab,
} from '@/lib/storage-providers';
import { S3_COMPATIBLE_DEFAULT_REGION } from '@evtivity/lib/object-storage-region';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';
import { isEditedField, useLoadedValues } from '@/hooks/use-loaded-values';

/** The URL parameter of the provider tab inside Settings > Integrations & Features > Storage. */
export const STORAGE_TAB_PARAM = 'storage';

/** The IAM policy the AWS S3 access key needs (the actions `S3ObjectStorage` uses). */
const AWS_IAM_POLICY = `{
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
}`;

/** The i18n key of each tab's provider name. */
const PROVIDER_NAME_KEY = {
  aws: 'settings.storage.providerAws',
  r2: 'settings.storage.providerR2',
  wasabi: 'settings.storage.providerWasabi',
  compatible: 'settings.storage.providerCompatible',
} as const satisfies Record<StorageTab, string>;

interface StoredStorage {
  provider: StorageProvider;
  /** The stored endpoint, as the API stored it. */
  endpoint: string;
  /** The tab of the stored provider. */
  tab: StorageTab;
  /** A bucket is stored: storage is set up. */
  configured: boolean;
}

/** One tab's form values. Each tab uses the fields of its provider only. */
export interface StorageFormValues {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** S3-compatible only. */
  endpoint: string;
  /** S3-compatible and Wasabi (Wasabi keeps the stored value, true for a new setup). */
  forcePathStyle: boolean;
  /** S3-compatible only, one host per line. */
  allowedHosts: string;
  /** Cloudflare R2 only. */
  accountId: string;
  jurisdiction: R2Jurisdiction;
}

/** The body of `PUT /v1/settings/s3`. */
export interface StorageSaveBody {
  provider: StorageProvider;
  bucket: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  allowedPrivateHosts?: string[];
  proof?: FactorProof;
}

function hostLines(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter((h) => h !== '');
}

/**
 * The endpoint a tab saves (as the API stores it), or '' for AWS S3. A Wasabi
 * tab keeps the stored service URL while its region is unchanged, so the
 * region-less us-east-1 URL (s3.wasabisys.com) is not a new destination.
 */
export function storageEndpointOf(
  tab: StorageTab,
  values: StorageFormValues,
  stored: StoredStorage,
): string {
  if (tab === 'aws') return '';
  if (tab === 'r2') return r2Endpoint(values.accountId, values.jurisdiction);
  if (tab === 'wasabi') {
    if (stored.tab === 'wasabi' && wasabiRegionOf(stored.endpoint) === values.region) {
      return stored.endpoint;
    }
    return values.region === '' ? '' : wasabiEndpoint(values.region);
  }
  return storedEndpointForm(values.endpoint);
}

/** Saving this tab points the credentials at another provider or endpoint. */
export function storageDestinationChanged(
  tab: StorageTab,
  values: StorageFormValues,
  stored: StoredStorage,
): boolean {
  if (providerOfTab(tab) !== stored.provider) return true;
  return tab !== 'aws' && storageEndpointOf(tab, values, stored) !== stored.endpoint;
}

/**
 * The save body of a tab. The keys go only when edited, or with a new
 * provider or endpoint (a stored key never follows a new destination);
 * otherwise the server keeps the stored keys, so keys another user rotated
 * since this form loaded stay (security cases 280 and 281).
 */
export function storageSaveBody(
  tab: StorageTab,
  values: StorageFormValues,
  base: StorageFormValues,
  stored: StoredStorage,
  proof: FactorProof | null,
): StorageSaveBody {
  const changed = storageDestinationChanged(tab, values, stored);
  const body: StorageSaveBody = {
    ...(proof != null ? { proof } : {}),
    provider: providerOfTab(tab),
    bucket: values.bucket.trim(),
  };
  // Cloudflare R2 has one region (auto), which the server sets.
  if (tab !== 'r2') body.region = values.region.trim();
  if (changed || isEditedField(values, base, 'accessKeyId')) {
    body.accessKeyId = values.accessKeyId;
  }
  if (changed || isEditedField(values, base, 'secretAccessKey')) {
    body.secretAccessKey = values.secretAccessKey;
  }
  if (tab === 'r2') body.endpoint = storageEndpointOf(tab, values, stored);
  if (tab === 'wasabi') {
    body.endpoint = storageEndpointOf(tab, values, stored);
    body.forcePathStyle = values.forcePathStyle;
    body.allowedPrivateHosts = [];
  }
  if (tab === 'compatible') {
    body.endpoint = values.endpoint.trim();
    body.forcePathStyle = values.forcePathStyle;
    body.allowedPrivateHosts = hostLines(values.allowedHosts);
  }
  return body;
}

/**
 * The origin browsers load stored images from, for STORAGE_IMG_SRC, or null
 * while the endpoint is not known. Path-style requests load from the endpoint,
 * virtual-hosted ones from the bucket's own host.
 */
export function storageImageOrigin(
  endpoint: string,
  bucket: string,
  pathStyle: boolean,
): string | null {
  const url = URL.parse(endpoint.trim());
  if (url == null || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  if (pathStyle) return url.origin;
  const name = bucket.trim();
  if (name === '') return null;
  return `${url.protocol}//${name}.${url.host}`;
}

/** The field a failed save refused with VALIDATION_ERROR, if any. */
function refusedField(err: unknown): unknown {
  if (!(err instanceof ApiError)) return undefined;
  const body = err.body as { code?: unknown; field?: unknown } | null;
  return body?.code === 'VALIDATION_ERROR' ? body.field : undefined;
}

type SaveErrorKey =
  | 'settings.storage.endpointRefused'
  | 'settings.storage.allowedHostsRefused'
  | 'settings.storage.r2EndpointRefused'
  | 'settings.storage.regionRequired'
  | 'settings.storage.saveFailed';

function saveErrorKey(err: unknown): SaveErrorKey {
  if (err instanceof ApiError && (err.body as { code?: unknown } | null)?.code === 'PRIVATE_URL') {
    return 'settings.storage.endpointRefused';
  }
  const field = refusedField(err);
  if (field === 'allowedPrivateHosts') return 'settings.storage.allowedHostsRefused';
  if (field === 'endpoint') return 'settings.storage.r2EndpointRefused';
  if (field === 'region') return 'settings.storage.regionRequired';
  return 'settings.storage.saveFailed';
}

interface StorageSettingsProps {
  settings: Record<string, unknown> | undefined;
}

/**
 * Settings > Integrations & Features > Storage: one tab per provider, each
 * with that provider's own fields and setup guide. Saving a tab makes its
 * provider the one that stores new files. Each tab keeps its own edits while
 * another tab is open.
 */
export function StorageSettings({ settings }: StorageSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const storedEndpoint =
    typeof settings?.['s3.endpoint'] === 'string' ? settings['s3.endpoint'] : '';
  const storedBucket = typeof settings?.['s3.bucket'] === 'string' ? settings['s3.bucket'] : '';
  const stored: StoredStorage = {
    provider: storageProviderOf(settings?.['s3.provider']),
    endpoint: storedEndpoint,
    tab: storageTabOf(settings?.['s3.provider'], storedEndpoint),
    configured: storedBucket.trim() !== '',
  };
  const [tabParam, setTab] = useTab(stored.tab, STORAGE_TAB_PARAM);
  // An unknown id falls back to the tab of the stored provider.
  const tab = storageTabParam(tabParam) ?? stored.tab;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.storage.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.storage.description')}</p>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            {STORAGE_TABS.map((id) => (
              <TabsTrigger key={id} value={id}>
                <span className="flex items-center gap-2">
                  {t(PROVIDER_NAME_KEY[id])}
                  {stored.configured && stored.tab === id && (
                    <Badge variant="success" size="sm" data-testid={`storage-active-${id}`}>
                      {t('settings.storage.active')}
                    </Badge>
                  )}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          {STORAGE_TABS.map((id) => (
            <TabsContent key={id} value={id} keepMounted>
              <StorageProviderForm tab={id} settings={settings} stored={stored} />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

/** A setter for one field of the form values. */
function field<K extends keyof StorageFormValues>(
  set: Dispatch<SetStateAction<StorageFormValues>>,
  key: K,
): (value: StorageFormValues[K]) => void {
  return (value) => {
    set((prev) => ({ ...prev, [key]: value }));
  };
}

function loadedValues(
  tab: StorageTab,
  settings: Record<string, unknown> | undefined,
  stored: StoredStorage,
): StorageFormValues {
  const str = (key: string): string => {
    const v = settings?.[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  // A tab shows the stored values only while its provider is the stored one;
  // another tab starts empty, so a stored key never shows for another provider.
  const mine = stored.tab === tab;
  const hosts = settings?.['s3.allowedPrivateHosts'];
  const r2 = mine && tab === 'r2' ? parseR2Endpoint(stored.endpoint) : null;
  const wasabiRegion = mine && tab === 'wasabi' ? wasabiRegionOf(stored.endpoint) : null;
  return {
    bucket: mine ? str('s3.bucket') : '',
    region: wasabiRegion ?? (mine && tab !== 'r2' ? str('s3.region') : ''),
    accessKeyId: mine ? str('s3.accessKeyIdEnc') : '',
    secretAccessKey: mine ? str('s3.secretAccessKeyEnc') : '',
    endpoint: mine && tab === 'compatible' ? stored.endpoint : '',
    // Most MinIO setups need path-style requests, and a path-style Wasabi
    // bucket loads images from the service URL, so a new setup starts with it.
    forcePathStyle: mine ? settings?.['s3.forcePathStyle'] === true : true,
    allowedHosts:
      mine && tab === 'compatible' && Array.isArray(hosts)
        ? hosts.filter((h) => typeof h === 'string').join('\n')
        : '',
    accountId: r2?.accountId ?? '',
    jurisdiction: r2?.jurisdiction ?? 'default',
  };
}

interface StorageProviderFormProps {
  tab: StorageTab;
  settings: Record<string, unknown> | undefined;
  stored: StoredStorage;
}

function StorageProviderForm({
  tab,
  settings,
  stored,
}: StorageProviderFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [values, setValues, takeLoad, base] = useLoadedValues(loadedValues(tab, settings, stored));
  const setBucket = field(setValues, 'bucket');
  const setRegion = field(setValues, 'region');
  const setAccessKeyId = field(setValues, 'accessKeyId');
  const setSecretAccessKey = field(setValues, 'secretAccessKey');
  const setEndpoint = field(setValues, 'endpoint');
  const setForcePathStyle = field(setValues, 'forcePathStyle');
  const setAllowedHosts = field(setValues, 'allowedHosts');
  const setAccountId = field(setValues, 'accountId');
  const setJurisdiction = field(setValues, 'jurisdiction');

  const { data: mfaStatus } = useMfaStatus();
  const proofKinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [proofFailure, setProofFailure] = useState<ProofRejection | null>(null);
  const [proofAsked, setProofAsked] = useState(false);
  const [proofRound, setProofRound] = useState(0);

  const providerName = t(PROVIDER_NAME_KEY[tab]);
  const isActive = stored.configured && stored.tab === tab;
  const destinationChanged = storageDestinationChanged(tab, values, stored);
  const needsProof = proofKinds.length > 0 && destinationChanged;
  const id = (name: string): string => `storage-${tab}-${name}`;

  const saveMutation = useMutation({
    mutationFn: (body: StorageSaveBody) => api.put('/v1/settings/s3', body),
    onError: (err: unknown) => {
      setProofFailure(proofRejection(err));
    },
    onSuccess: () => {
      setProof(null);
      setProofAsked(false);
      setProofFailure(null);
      setProofRound((n) => n + 1);
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['s3-status'] });
    },
  });
  const testMutation = useMutation({
    mutationFn: () => api.post('/v1/settings/s3/test', {}),
  });

  const accountIdShown = values.accountId.trim() !== '';
  const accountIdValid = isR2AccountId(values.accountId);
  const missing =
    values.bucket.trim() === '' ||
    ((tab === 'aws' || tab === 'wasabi') && values.region.trim() === '') ||
    (tab === 'r2' && !accountIdValid) ||
    (tab === 'compatible' && values.endpoint.trim() === '') ||
    values.accessKeyId === '' ||
    values.secretAccessKey === '';

  const storedSecret =
    stored.tab === tab &&
    typeof settings?.['s3.secretAccessKeyEnc'] === 'string' &&
    settings['s3.secretAccessKeyEnc'] !== '';

  const endpoint = storageEndpointOf(tab, values, stored);
  const imageOrigin =
    tab === 'r2'
      ? accountIdValid
        ? storageImageOrigin(endpoint, values.bucket, true)
        : null
      : tab === 'aws'
        ? null
        : storageImageOrigin(endpoint, values.bucket, values.forcePathStyle);

  const save = (): void => {
    if (needsProof && proof == null) {
      setProofAsked(true);
      return;
    }
    const body = storageSaveBody(tab, values, base, stored, needsProof ? proof : null);
    saveMutation.mutate(body, {
      onSuccess: () => {
        takeLoad(values);
      },
    });
  };

  const regionSelect = (regions: readonly StorageRegion[], hint: string): React.JSX.Element => {
    // A stored region outside the list (one the provider added later) stays selectable.
    const known = regions.some((r) => r.code === values.region);
    return (
      <div className="space-y-2">
        <Label htmlFor={id('region')} className="leading-6">
          {t('settings.storage.region')}
        </Label>
        <Select
          id={id('region')}
          value={values.region}
          onChange={(e) => {
            setRegion(e.target.value);
          }}
        >
          <option value="">{t('settings.storage.regionSelect')}</option>
          {!known && values.region !== '' && <option value={values.region}>{values.region}</option>}
          {regions.map((r) => (
            <option key={r.code} value={r.code}>
              {`${r.name}, ${r.code}`}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid={`storage-tab-${tab}`}>
      <Alert variant={isActive ? 'success' : 'info'} data-testid={`storage-status-${tab}`}>
        {isActive ? <CheckCircle2 className="h-4 w-4" /> : <Info className="h-4 w-4" />}
        <AlertDescription>
          {isActive
            ? t('settings.storage.statusActive', { provider: providerName })
            : stored.configured
              ? t('settings.storage.statusOther', {
                  provider: providerName,
                  active: t(PROVIDER_NAME_KEY[stored.tab]),
                })
              : t('settings.storage.statusNone', { provider: providerName })}
        </AlertDescription>
      </Alert>
      <p className="text-sm text-muted-foreground">
        {t(`settings.storage.${tab}Description` as const)}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 items-start">
        {tab === 'r2' && (
          <>
            <div className="space-y-2">
              <Label htmlFor={id('account-id')} className="leading-6">
                {t('settings.storage.r2AccountId')}
              </Label>
              <Input
                id={id('account-id')}
                value={values.accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <p
                className={`text-xs ${accountIdShown && !accountIdValid ? 'text-destructive' : 'text-muted-foreground'}`}
              >
                {accountIdShown && !accountIdValid
                  ? t('settings.storage.r2AccountIdInvalid')
                  : t('settings.storage.r2AccountIdHint')}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor={id('jurisdiction')} className="leading-6">
                {t('settings.storage.r2Jurisdiction')}
              </Label>
              <Select
                id={id('jurisdiction')}
                value={values.jurisdiction}
                onChange={(e) => {
                  const next = R2_JURISDICTIONS.find((j) => j === e.target.value);
                  if (next != null) setJurisdiction(next);
                }}
              >
                {R2_JURISDICTIONS.map((j) => (
                  <option key={j} value={j}>
                    {t(`settings.storage.r2Jurisdictions.${j}` as const)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('settings.storage.r2JurisdictionHint')}
              </p>
            </div>
          </>
        )}

        {tab === 'compatible' && (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={id('endpoint')} className="leading-6">
              {t('settings.storage.endpoint')}
            </Label>
            <Input
              id={id('endpoint')}
              value={values.endpoint}
              onChange={(e) => {
                setEndpoint(e.target.value);
              }}
              placeholder="https://s3.example.com"
            />
            <p className="text-xs text-muted-foreground">{t('settings.storage.endpointHint')}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={id('bucket')} className="leading-6">
            {t('settings.storage.bucket')}
          </Label>
          <Input
            id={id('bucket')}
            value={values.bucket}
            onChange={(e) => {
              setBucket(e.target.value);
            }}
          />
        </div>

        {tab === 'aws' && regionSelect(AWS_S3_REGIONS, t('settings.storage.awsRegionHint'))}
        {tab === 'wasabi' &&
          regionSelect(
            WASABI_REGIONS,
            values.region === ''
              ? t('settings.storage.wasabiRegionHint')
              : t('settings.storage.wasabiServiceUrl', { url: endpoint }),
          )}
        {tab === 'compatible' && (
          <div className="space-y-2">
            <Label htmlFor={id('region')} className="leading-6">
              {t('settings.storage.region')}
            </Label>
            <Input
              id={id('region')}
              value={values.region}
              onChange={(e) => {
                setRegion(e.target.value);
              }}
              placeholder={S3_COMPATIBLE_DEFAULT_REGION}
            />
            <p className="text-xs text-muted-foreground">
              {t('settings.storage.compatibleRegionHint', {
                region: S3_COMPATIBLE_DEFAULT_REGION,
              })}
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor={id('access-key')} className="leading-6">
            {t('settings.storage.accessKeyId')}
          </Label>
          <Input
            id={id('access-key')}
            value={values.accessKeyId}
            onChange={(e) => {
              setAccessKeyId(e.target.value);
            }}
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id('secret-key')} className="leading-6">
            {t('settings.storage.secretAccessKey')}
          </Label>
          <PasswordInput
            id={id('secret-key')}
            value={values.secretAccessKey}
            onChange={(e) => {
              setSecretAccessKey(e.target.value);
            }}
            placeholder={storedSecret ? '********' : ''}
          />
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {t(`settings.storage.${tab}KeysHint` as const)}
        </p>
      </div>

      {tab === 'r2' && accountIdValid && (
        <p
          className="text-sm text-muted-foreground wrap-anywhere"
          data-testid="storage-r2-endpoint"
        >
          {t('settings.storage.r2EndpointBuilt', { url: endpoint })}
        </p>
      )}

      {tab === 'compatible' && (
        <>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={id('path-style')}
                checked={values.forcePathStyle}
                onChange={(e) => {
                  setForcePathStyle(e.target.checked);
                }}
              />
              <Label htmlFor={id('path-style')} className="font-normal">
                {t('settings.storage.pathStyle')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings.storage.pathStyleHint')}</p>
          </div>
          <Collapsible
            title={t('settings.storage.advanced')}
            summary={
              hostLines(values.allowedHosts).length > 0
                ? t('settings.storage.advancedPrivateHosts', {
                    count: hostLines(values.allowedHosts).length,
                  })
                : t('settings.storage.advancedNone')
            }
            data-testid="storage-advanced"
          >
            <div className="space-y-2">
              <Label htmlFor={id('allowed-hosts')} className="leading-6">
                {t('settings.storage.allowedPrivateHosts')}
              </Label>
              <Textarea
                id={id('allowed-hosts')}
                rows={3}
                value={values.allowedHosts}
                onChange={(e) => {
                  setAllowedHosts(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.storage.allowedPrivateHostsHint')}
              </p>
            </div>
          </Collapsible>
        </>
      )}

      {needsProof && (
        <FactorProofField
          key={`${tab}-${String(proofRound)}`}
          idPrefix={id('proof')}
          kinds={proofKinds}
          codeMethod={mfaStatus?.mfaMethod ?? null}
          description={t('settings.storage.proofHint')}
          onChange={setProof}
          rejection={proofFailure}
          showMissing={proofAsked}
        />
      )}

      <div className="flex flex-wrap justify-end gap-2">
        <SaveButton
          isPending={saveMutation.isPending}
          type="button"
          disabled={missing}
          {...(isActive
            ? {}
            : { label: t('settings.storage.saveAndUse', { provider: providerName }) })}
          onClick={save}
        />
        {isActive && (
          <Button
            variant="outline"
            onClick={() => {
              testMutation.mutate();
            }}
            disabled={testMutation.isPending}
          >
            <Send className="h-4 w-4" />
            {t('settings.storage.test')}
          </Button>
        )}
      </div>
      {isActive && (
        <p className="text-xs text-muted-foreground text-right">{t('settings.storage.testHint')}</p>
      )}
      {saveMutation.isSuccess && (
        <p className="text-sm text-success text-right">{t('settings.storage.saved')}</p>
      )}
      {saveMutation.isError && (
        <p className="text-sm text-destructive text-right">{t(saveErrorKey(saveMutation.error))}</p>
      )}
      {testMutation.isSuccess && (
        <p className="text-sm text-success text-right">{t('settings.storage.testSuccess')}</p>
      )}
      {testMutation.isError && (
        <p className="text-sm text-destructive text-right">{t('settings.storage.testFailed')}</p>
      )}

      <StorageSetupGuide tab={tab} imageOrigin={imageOrigin} />
    </div>
  );
}

interface StorageSetupGuideProps {
  tab: StorageTab;
  /** The origin to add to STORAGE_IMG_SRC, null while the endpoint is not known. */
  imageOrigin: string | null;
}

/** The provider's setup steps: access key permissions, bucket CORS rules and the image origin. */
function StorageSetupGuide({ tab, imageOrigin }: StorageSetupGuideProps): React.JSX.Element {
  const { t } = useTranslation();
  const csmsOrigin = window.location.origin;

  const imageOriginNote =
    imageOrigin != null ? (
      <div className="space-y-1" data-testid="storage-image-origin">
        <p className="text-sm text-muted-foreground">{t('settings.storage.imageOrigin')}</p>
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 rounded-sm bg-muted px-1 py-0.5 text-xs wrap-anywhere">
            {imageOrigin}
          </code>
          <CopyButton value={imageOrigin} />
        </div>
      </div>
    ) : (
      <p className="text-sm text-muted-foreground">{t('settings.storage.imageOriginPending')}</p>
    );

  if (tab === 'aws') {
    return (
      <div className="space-y-2 border-t pt-4" data-testid="storage-setup-aws">
        <Collapsible title={t('settings.storage.awsPolicyTitle')}>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('settings.storage.awsPolicyDescription')}
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs">{AWS_IAM_POLICY}</pre>
            <p className="text-sm text-muted-foreground">
              {t('settings.storage.bucketPrivateNote')}
            </p>
          </div>
        </Collapsible>
        <Collapsible title={t('settings.storage.corsTitle')}>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('settings.storage.awsCorsDescription')}
            </p>
            <pre
              className="overflow-x-auto rounded-md bg-muted p-4 text-xs"
              data-testid="storage-cors-example"
            >
              {buildS3CorsExample(csmsOrigin, PORTAL_BASE_URL)}
            </pre>
          </div>
        </Collapsible>
      </div>
    );
  }

  if (tab === 'r2') {
    return (
      <div className="space-y-3 border-t pt-4" data-testid="storage-setup-r2">
        <h3 className="text-sm font-medium">{t('settings.storage.r2TokenTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.storage.r2TokenDescription')}</p>
        <h3 className="text-sm font-medium">{t('settings.storage.corsTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.storage.r2CorsDescription')}</p>
        <pre
          className="overflow-x-auto rounded-md bg-muted p-4 text-xs"
          data-testid="storage-cors-example"
        >
          {buildS3CorsExample(csmsOrigin, PORTAL_BASE_URL, 'PUT')}
        </pre>
        <p className="text-sm text-muted-foreground">{t('settings.storage.bucketPrivateNote')}</p>
        {imageOriginNote}
        <a
          href={R2_SETUP_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm text-link hover:underline"
        >
          {t('settings.storage.r2DocsLink')}
        </a>
      </div>
    );
  }

  // Wasabi and S3-compatible services take presigned POST uploads.
  return (
    <div className="space-y-3 border-t pt-4" data-testid={`storage-setup-${tab}`}>
      <h3 className="text-sm font-medium">{t('settings.storage.setupTitle')}</h3>
      <p className="text-sm text-muted-foreground">
        {t(`settings.storage.${tab}SetupPermissions` as const)}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {STORAGE_ACCESS_ACTIONS.map(({ id, action }) => (
          <li key={id}>
            {t(`settings.storage.permission.${id}` as const)}{' '}
            <code className="rounded-sm bg-muted px-1 py-0.5 text-xs">{action}</code>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t('settings.storage.setupCors')}</p>
      <ul className="space-y-1" data-testid="storage-cors-origins">
        {storageBrowserOrigins(csmsOrigin, PORTAL_BASE_URL).map(({ origin, placeholder }) => (
          <li key={origin} className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 rounded-sm bg-muted px-1 py-0.5 text-xs wrap-anywhere">
              {origin}
            </code>
            {!placeholder && <CopyButton value={origin} />}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted-foreground">{t('settings.storage.bucketPrivateNote')}</p>
      {imageOriginNote}
      <a
        href={S3_COMPATIBLE_SETUP_DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block text-sm text-link hover:underline"
      >
        {t(`settings.storage.${tab}DocsLink` as const)}
      </a>
    </div>
  );
}
