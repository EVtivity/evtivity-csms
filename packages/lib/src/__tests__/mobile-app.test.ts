// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import * as mobileAppModule from '../mobile-app.js';

describe('parseMobileAppList', () => {
  it('normalizes schemes and refuses browser and reserved schemes', async () => {
    const { parseMobileAppList, MOBILE_APP_URL_SCHEMES_KEY: key } = mobileAppModule;
    expect(parseMobileAppList(key, [' EVtivity ', 'evtivity', 'my-app.v2'])).toEqual([
      'evtivity',
      'my-app.v2',
    ]);
    expect(parseMobileAppList(key, [])).toEqual([]);
    for (const bad of ['https', 'http', 'javascript', 'adyencheckout', '1app', 'a b', '']) {
      expect(parseMobileAppList(key, [bad])).toBeNull();
    }
    expect(parseMobileAppList(key, 'evtivity')).toBeNull();
    expect(parseMobileAppList(key, [42])).toBeNull();
  });

  it('accepts Android application ids only', async () => {
    const { parseMobileAppList, MOBILE_APP_ANDROID_PACKAGES_KEY: key } = mobileAppModule;
    expect(parseMobileAppList(key, ['com.evtivity.driver', 'com.Op_1.app'])).toEqual([
      'com.evtivity.driver',
      'com.Op_1.app',
    ]);
    for (const bad of ['evtivity', 'com..app', '1com.app', 'com.app/x']) {
      expect(parseMobileAppList(key, [bad])).toBeNull();
    }
  });

  it('names the two keys', async () => {
    const { isMobileAppSettingKey } = mobileAppModule;
    expect(isMobileAppSettingKey('mobile.app.urlSchemes')).toBe(true);
    expect(isMobileAppSettingKey('mobile.app.androidPackageNames')).toBe(true);
    expect(isMobileAppSettingKey('mobile.attestation.enabled')).toBe(false);
  });
});
