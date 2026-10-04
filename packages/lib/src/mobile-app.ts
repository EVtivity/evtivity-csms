// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The operator's mobile app builds (one per brand, `brands/` in the mobile
 * repo). The API accepts a 3D Secure return URL from the app only when it
 * leads back to one of these apps (plan P10 Part E):
 *
 * - `mobile.app.urlSchemes`: custom URL schemes of the app builds (the brand
 *   `scheme`, default `evtivity`). iOS returns to `<scheme>://...`.
 * - `mobile.app.androidPackageNames`: Android application ids (the brand
 *   `androidPackage`, default `com.evtivity.driver`). The Adyen Android SDK
 *   returns to `adyencheckout://<application id>`.
 *
 * The cached reader is `getMobileAppConfig()` in `@evtivity/database`.
 */
export const MOBILE_APP_URL_SCHEMES_KEY = 'mobile.app.urlSchemes';
export const MOBILE_APP_ANDROID_PACKAGES_KEY = 'mobile.app.androidPackageNames';

export interface MobileAppConfig {
  urlSchemes: string[];
  androidPackageNames: string[];
}

// RFC 3986 scheme. Browser schemes are refused: a return URL with them would
// leave the app. adyencheckout is the Adyen Android SDK scheme, accepted only
// with a listed application id.
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/;
const RESERVED_SCHEMES = new Set([
  'http',
  'https',
  'javascript',
  'data',
  'file',
  'about',
  'blob',
  'adyencheckout',
]);
// Android application id: at least two segments, each starting with a letter.
const PACKAGE_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export function isAppUrlScheme(value: string): boolean {
  return SCHEME_PATTERN.test(value) && !RESERVED_SCHEMES.has(value);
}

export function isAndroidPackageName(value: string): boolean {
  return PACKAGE_PATTERN.test(value);
}

export function isMobileAppSettingKey(key: string): boolean {
  return key === MOBILE_APP_URL_SCHEMES_KEY || key === MOBILE_APP_ANDROID_PACKAGES_KEY;
}

/**
 * Normalizes a stored or submitted value of one of the two keys: an array of
 * valid, unique entries (schemes trimmed and lowercased, ids trimmed). Null
 * when the value is not an array of valid strings.
 */
export function parseMobileAppList(key: string, value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const isScheme = key === MOBILE_APP_URL_SCHEMES_KEY;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const entry = isScheme ? item.trim().toLowerCase() : item.trim();
    if (!(isScheme ? isAppUrlScheme(entry) : isAndroidPackageName(entry))) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
