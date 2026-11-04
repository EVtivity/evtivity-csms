// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export const CSMS_ORIGIN_PLACEHOLDER = 'YOUR_CSMS_ORIGIN';
export const PORTAL_ORIGIN_PLACEHOLDER = 'YOUR_PORTAL_ORIGIN';

/** The scheme, host and port of a URL, or the placeholder when it does not parse. */
export function originOrPlaceholder(url: string | null | undefined, placeholder: string): string {
  if (url == null || url === '') return placeholder;
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return placeholder;
  }
  return parsed.origin;
}

/**
 * The browser origins a bucket's CORS rules must allow (the CSMS and the
 * driver portal), deduplicated, each with whether it is a placeholder (the
 * portal address is not known to this build).
 */
export function storageBrowserOrigins(
  csmsUrl: string | null,
  portalUrl: string | null,
): Array<{ origin: string; placeholder: boolean }> {
  const origins = [
    originOrPlaceholder(csmsUrl, CSMS_ORIGIN_PLACEHOLDER),
    originOrPlaceholder(portalUrl, PORTAL_ORIGIN_PLACEHOLDER),
  ];
  return [...new Set(origins)].map((origin) => ({
    origin,
    placeholder: origin === CSMS_ORIGIN_PLACEHOLDER || origin === PORTAL_ORIGIN_PLACEHOLDER,
  }));
}

/**
 * The permissions the storage access key needs, as plain actions and the S3
 * actions behind them. `S3ObjectStorage` uploads with a presigned POST (a
 * presigned PUT on Cloudflare R2) and PutObject (s3:PutObject), reads with GetObject, HeadObject and presigned GET
 * links (s3:GetObject), deletes with DeleteObject and DeleteObjects
 * (s3:DeleteObject), and lists with ListObjectsV2 (s3:ListBucket, also the
 * Test Connection check).
 */
export const STORAGE_ACCESS_ACTIONS = [
  { id: 'upload', action: 's3:PutObject' },
  { id: 'read', action: 's3:GetObject' },
  { id: 'delete', action: 's3:DeleteObject' },
  { id: 'list', action: 's3:ListBucket' },
] as const;

/** The website section with the MinIO and Wasabi setup steps. */
export const S3_COMPATIBLE_SETUP_DOCS_URL =
  'https://evtivity.com/docs/csms/settings#minio-and-wasabi-setup';

/**
 * The bucket CORS rule for browser uploads (station images and support
 * attachments from the CSMS, driver photos from the portal) and downloads
 * (presigned GET links), so both origins need the upload method and GET.
 * Uploads are presigned POST forms, or on Cloudflare R2 (`uploadMethod` PUT)
 * a PUT that sends a Content-Type header.
 */
export function buildS3CorsExample(
  csmsUrl: string | null,
  portalUrl: string | null,
  uploadMethod: 'POST' | 'PUT' = 'POST',
): string {
  const origins = [
    originOrPlaceholder(csmsUrl, CSMS_ORIGIN_PLACEHOLDER),
    originOrPlaceholder(portalUrl, PORTAL_ORIGIN_PLACEHOLDER),
  ];
  const rule = [
    {
      AllowedHeaders: uploadMethod === 'PUT' ? ['content-type'] : ['*'],
      AllowedMethods: [uploadMethod, 'GET'],
      AllowedOrigins: [...new Set(origins)],
      ExposeHeaders: [],
      MaxAgeSeconds: 300,
    },
  ];
  return JSON.stringify(rule, null, 2);
}
