// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The storage providers of Settings > Integrations & Features > Storage, one
 * tab each. The API knows three provider values (`s3.provider`): `s3` (AWS
 * S3), `s3-compatible` and `r2`. Wasabi is a preset of `s3-compatible`: its
 * tab fills the endpoint from the region (Wasabi has one fixed service URL per
 * region), so no new provider value or API change is needed.
 */

/** The provider value `PUT /v1/settings/s3` takes. */
export type StorageProvider = 's3' | 's3-compatible' | 'r2';

/** The storage tabs, in display order. */
export const STORAGE_TABS = ['aws', 'r2', 'wasabi', 'compatible'] as const;
export type StorageTab = (typeof STORAGE_TABS)[number];

/** A stored or picked provider; anything else is AWS S3, the default. */
export function storageProviderOf(value: unknown): StorageProvider {
  return value === 's3-compatible' || value === 'r2' ? value : 's3';
}

/** The provider value a tab saves. */
export function providerOfTab(tab: StorageTab): StorageProvider {
  if (tab === 'aws') return 's3';
  if (tab === 'r2') return 'r2';
  return 's3-compatible';
}

/** The endpoint as the API stores it (the origin), to tell whether it changed. */
export function storedEndpointForm(value: string): string {
  return URL.parse(value.trim())?.origin ?? value.trim();
}

/**
 * The tab of the stored settings: R2 and AWS S3 by provider, an S3-compatible
 * endpoint on a Wasabi service URL as Wasabi, any other one as S3-compatible.
 */
export function storageTabOf(provider: unknown, endpoint: unknown): StorageTab {
  const p = storageProviderOf(provider);
  if (p === 'r2') return 'r2';
  if (p === 's3') return 'aws';
  return wasabiRegionOf(typeof endpoint === 'string' ? endpoint : '') != null
    ? 'wasabi'
    : 'compatible';
}

/** An id of a tab from the URL, or null for an unknown one. */
export function storageTabParam(value: string | null): StorageTab | null {
  return STORAGE_TABS.find((tab) => tab === value) ?? null;
}

export interface StorageRegion {
  code: string;
  /** The provider's own name of the region (a proper name, not translated). */
  name: string;
}

/**
 * AWS commercial regions (GovCloud, China and the European Sovereign Cloud are
 * separate partitions with other endpoints, so they are left out). Source: AWS
 * General Reference, "Amazon Simple Storage Service endpoints and quotas",
 * https://docs.aws.amazon.com/general/latest/gr/s3.html , and "AWS Regions",
 * https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html .
 * A stored region outside this list stays selectable (a region AWS added later).
 */
export const AWS_S3_REGIONS: readonly StorageRegion[] = [
  { code: 'us-east-1', name: 'US East (N. Virginia)' },
  { code: 'us-east-2', name: 'US East (Ohio)' },
  { code: 'us-west-1', name: 'US West (N. California)' },
  { code: 'us-west-2', name: 'US West (Oregon)' },
  { code: 'af-south-1', name: 'Africa (Cape Town)' },
  { code: 'ap-east-1', name: 'Asia Pacific (Hong Kong)' },
  { code: 'ap-east-2', name: 'Asia Pacific (Taipei)' },
  { code: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
  { code: 'ap-south-2', name: 'Asia Pacific (Hyderabad)' },
  { code: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { code: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { code: 'ap-southeast-3', name: 'Asia Pacific (Jakarta)' },
  { code: 'ap-southeast-4', name: 'Asia Pacific (Melbourne)' },
  { code: 'ap-southeast-5', name: 'Asia Pacific (Malaysia)' },
  { code: 'ap-southeast-6', name: 'Asia Pacific (New Zealand)' },
  { code: 'ap-southeast-7', name: 'Asia Pacific (Thailand)' },
  { code: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { code: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
  { code: 'ap-northeast-3', name: 'Asia Pacific (Osaka)' },
  { code: 'ca-central-1', name: 'Canada (Central)' },
  { code: 'ca-west-1', name: 'Canada West (Calgary)' },
  { code: 'eu-central-1', name: 'Europe (Frankfurt)' },
  { code: 'eu-central-2', name: 'Europe (Zurich)' },
  { code: 'eu-west-1', name: 'Europe (Ireland)' },
  { code: 'eu-west-2', name: 'Europe (London)' },
  { code: 'eu-west-3', name: 'Europe (Paris)' },
  { code: 'eu-south-1', name: 'Europe (Milan)' },
  { code: 'eu-south-2', name: 'Europe (Spain)' },
  { code: 'eu-north-1', name: 'Europe (Stockholm)' },
  { code: 'il-central-1', name: 'Israel (Tel Aviv)' },
  { code: 'me-south-1', name: 'Middle East (Bahrain)' },
  { code: 'me-central-1', name: 'Middle East (UAE)' },
  { code: 'mx-central-1', name: 'Mexico (Central)' },
  { code: 'sa-east-1', name: 'South America (São Paulo)' },
];

/**
 * Wasabi storage regions and their service URLs (`s3.<region>.wasabisys.com`).
 * Source: Wasabi docs, "Service URLs for Wasabi's Storage Regions",
 * https://docs.wasabi.com/docs/service-urls-for-wasabis-storage-regions .
 * Wasabi supports path-style and virtual-hosted requests and recommends
 * path-style (https://docs.wasabi.com/apidocs/rest-api-introduction).
 */
export const WASABI_REGIONS: readonly StorageRegion[] = [
  { code: 'us-east-1', name: 'US East 1 (N. Virginia)' },
  { code: 'us-east-2', name: 'US East 2 (N. Virginia)' },
  { code: 'us-central-1', name: 'US Central 1 (Texas)' },
  { code: 'us-west-1', name: 'US West 1 (Oregon)' },
  { code: 'us-west-2', name: 'US West 2 (San Jose)' },
  { code: 'ca-central-1', name: 'CA Central 1 (Toronto)' },
  { code: 'eu-central-1', name: 'EU Central 1 (Amsterdam)' },
  { code: 'eu-central-2', name: 'EU Central 2 (Frankfurt)' },
  { code: 'eu-west-1', name: 'EU West 1 (United Kingdom)' },
  { code: 'eu-west-2', name: 'EU West 2 (Paris)' },
  { code: 'eu-west-3', name: 'EU West 3 (United Kingdom)' },
  { code: 'eu-south-1', name: 'EU South 1 (Milan)' },
  { code: 'ap-northeast-1', name: 'AP Northeast 1 (Tokyo)' },
  { code: 'ap-northeast-2', name: 'AP Northeast 2 (Osaka)' },
  { code: 'ap-southeast-1', name: 'AP Southeast 1 (Singapore)' },
  { code: 'ap-southeast-2', name: 'AP Southeast 2 (Sydney)' },
];

/**
 * The other service URL hosts Wasabi lists for a region (same source):
 * `s3.wasabisys.com` for us-east-1 and the older country names in Europe.
 */
const WASABI_HOST_ALIASES: Readonly<Record<string, string>> = {
  's3.wasabisys.com': 'us-east-1',
  's3.nl-1.wasabisys.com': 'eu-central-1',
  's3.de-1.wasabisys.com': 'eu-central-2',
  's3.uk-1.wasabisys.com': 'eu-west-1',
  's3.fr-1.wasabisys.com': 'eu-west-2',
  's3.uk-2.wasabisys.com': 'eu-west-3',
  's3.it-1.wasabisys.com': 'eu-south-1',
};

/** The Wasabi service URL of a region. */
export function wasabiEndpoint(region: string): string {
  return `https://s3.${region}.wasabisys.com`;
}

/**
 * The Wasabi region of an endpoint, or null when it is not a Wasabi service
 * URL (https, no port or path).
 */
export function wasabiRegionOf(endpoint: string): string | null {
  const url = URL.parse(endpoint.trim());
  if (url?.protocol !== 'https:' || url.port !== '' || url.pathname !== '/') return null;
  const host = url.hostname.toLowerCase();
  const alias = WASABI_HOST_ALIASES[host];
  if (alias != null) return alias;
  const match = /^s3\.([a-z0-9-]+)\.wasabisys\.com$/.exec(host);
  const region = match?.[1];
  return region != null && WASABI_REGIONS.some((r) => r.code === region) ? region : null;
}

/**
 * Cloudflare R2 jurisdictions: where the bucket's data is stored, set when
 * the bucket is created. Every jurisdiction Cloudflare lists, all accepted by
 * `validateR2Endpoint`.
 */
export const R2_JURISDICTIONS = ['default', 'eu', 'fedramp', 'us'] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/** An R2 account ID: 32 hexadecimal characters. */
export function isR2AccountId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value.trim().toLowerCase());
}

/**
 * The R2 S3 API URL of an account and jurisdiction:
 * `https://<account id>.r2.cloudflarestorage.com`, with `.eu`, `.fedramp` or
 * `.us` before `r2` for those jurisdictions. Source: Cloudflare R2 docs, "S3 API
 * compatibility" (https://developers.cloudflare.com/r2/api/s3/api/) and "Data
 * location" (https://developers.cloudflare.com/r2/reference/data-location/).
 * The API checks it with `validateR2Endpoint`.
 */
export function r2Endpoint(accountId: string, jurisdiction: R2Jurisdiction): string {
  const id = accountId.trim().toLowerCase();
  const part = jurisdiction === 'default' ? '' : `${jurisdiction}.`;
  return `https://${id}.${part}r2.cloudflarestorage.com`;
}

/** The account ID and jurisdiction of a stored R2 endpoint (empty when it does not parse). */
export function parseR2Endpoint(endpoint: string): {
  accountId: string;
  jurisdiction: R2Jurisdiction;
} {
  const host = URL.parse(endpoint.trim())?.hostname.toLowerCase() ?? '';
  const match = /^([0-9a-f]{32})\.(?:(eu|fedramp|us)\.)?r2\.cloudflarestorage\.com$/.exec(host);
  if (match?.[1] == null) return { accountId: '', jurisdiction: 'default' };
  const jurisdiction =
    match[2] === 'eu' || match[2] === 'fedramp' || match[2] === 'us' ? match[2] : 'default';
  return { accountId: match[1], jurisdiction };
}
