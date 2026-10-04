// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import type { AppBrowserContext, BrowserContext } from '@evtivity/payments';
import type { MobileAppConfig } from '@evtivity/lib';
import { ERROR_CODES } from './error-codes.generated.js';

/**
 * The shopper's browser for a 3D Secure round trip (plan P10 Part B). The
 * client sends its page origin and the browser info its card UI collected;
 * the return URL the issuer sends the shopper back to is always built here
 * from PORTAL_URL or CSMS_URL, never taken from the client.
 */
export const shopperBrowserBody = z
  .object({
    origin: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Origin of the page that runs the card UI (window.location.origin, no trailing slash). Must be the origin of the configured portal or dashboard URL',
      ),
    info: z
      .unknown()
      .optional()
      .describe(
        "Browser info the provider's card UI collected for 3D Secure (Adyen: state.data.browserInfo)",
      ),
  })
  .describe(
    'The browser the shopper is in, needed when the card can ask for 3D Secure (Adyen). The return URL is built by the server',
  );

export type ShopperBrowserInput = z.infer<typeof shopperBrowserBody>;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    // A malformed URL has no origin; the caller refuses it.
    return null;
  }
}

/**
 * The browser context for the provider: the client's origin when it matches
 * the configured app URL (else null: the caller answers 400), and the return
 * URL `<appUrl><returnPath>` with `query`.
 */
export function shopperBrowserContext(
  input: ShopperBrowserInput,
  appUrl: string,
  returnPath: string,
  query: Record<string, string>,
): BrowserContext | null {
  const appOrigin = originOf(appUrl);
  if (appOrigin == null || input.origin !== appOrigin) return null;
  const returnUrl = new URL(`${appUrl.replace(/\/+$/, '')}${returnPath}`);
  for (const [key, value] of Object.entries(query)) returnUrl.searchParams.set(key, value);
  return {
    origin: appOrigin,
    returnUrl: returnUrl.toString(),
    ...(input.info !== undefined ? { info: input.info } : {}),
  };
}

/** The 400 body for a browser origin that is not the configured app's. */
export function originMismatchError(appUrl: string): { error: string; code: string } {
  return {
    error: `browser.origin must be ${originOf(appUrl) ?? appUrl}, the configured app URL`,
    code: ERROR_CODES.VALIDATION_ERROR,
  };
}

/**
 * The mobile app as the shopper's "browser" (plan P10 Part E). A native
 * payment SDK owns its return URL (Adyen: the configured custom scheme on
 * iOS, `adyencheckout://<application id>` on Android), so the app sends it and
 * the server accepts it only when it leads back to an app build the operator
 * listed in the `mobile.app.*` settings.
 */
export const appShopperBody = z
  .object({
    platform: z
      .enum(['ios', 'android'])
      .describe('Platform of the mobile app; sets the provider channel (Adyen: iOS or Android)'),
    returnUrl: z
      .string()
      .min(1)
      .max(1024)
      .describe(
        "Return URL of the app's payment SDK (Adyen: onSubmit data.returnUrl). iOS: a custom URL scheme listed in mobile.app.urlSchemes. Android: adyencheckout://<application id> with the id listed in mobile.app.androidPackageNames, or a listed scheme",
      ),
    info: z
      .unknown()
      .optional()
      .describe("Browser info the app's payment SDK collected (Adyen: data.browserInfo)"),
  })
  .describe('The mobile app the shopper is in, for a 3D Secure step');

export type AppShopperInput = z.infer<typeof appShopperBody>;

/** The scheme of the Adyen Android SDK return URL (adyen-android RedirectComponent.getReturnUrl). */
const ADYEN_ANDROID_RETURN_SCHEME = 'adyencheckout';

/**
 * The app context for the provider, or null when the return URL does not lead
 * back to a configured app build (the caller answers 400).
 */
export function appShopperContext(
  input: AppShopperInput,
  apps: MobileAppConfig,
): AppBrowserContext | null {
  let url: URL;
  try {
    url = new URL(input.returnUrl);
  } catch {
    // Not a URL: refused.
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const toApp = apps.urlSchemes.includes(scheme);
  const toAndroidSdk =
    input.platform === 'android' &&
    scheme === ADYEN_ANDROID_RETURN_SCHEME &&
    apps.androidPackageNames.includes(url.host) &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '' || url.pathname === '/') &&
    url.search === '' &&
    url.hash === '';
  if (!toApp && !toAndroidSdk) return null;
  return {
    channel: input.platform,
    returnUrl: input.returnUrl,
    ...(input.info !== undefined ? { info: input.info } : {}),
  };
}

/** The 400 body for an app return URL that leads to no configured app build. */
export function appReturnUrlError(): { error: string; code: string } {
  return {
    error:
      'browser.returnUrl must lead back to a configured app build (settings mobile.app.urlSchemes and mobile.app.androidPackageNames)',
    code: ERROR_CODES.VALIDATION_ERROR,
  };
}
