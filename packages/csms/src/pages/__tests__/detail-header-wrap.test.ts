// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import configTemplate from '../ConfigTemplateDetail.tsx?raw';
import configTemplatePush from '../ConfigTemplatePushDetail.tsx?raw';
import conformanceRun from '../ConformanceDetail.tsx?raw';
import firmwareCampaign from '../FirmwareCampaignDetail.tsx?raw';
import firmwareProgress from '../FirmwareCampaignProgressDetail.tsx?raw';
import pricingGroup from '../PricingGroupDetail.tsx?raw';
import roamingTariff from '../RoamingTariffMappingDetail.tsx?raw';
import smartChargingPush from '../SmartChargingPushDetail.tsx?raw';
import smartChargingTemplate from '../SmartChargingTemplateDetail.tsx?raw';
import tariff from '../TariffDetail.tsx?raw';
import token from '../TokenDetail.tsx?raw';

const PAGES: Record<string, string> = {
  configTemplate,
  configTemplatePush,
  conformanceRun,
  firmwareCampaign,
  firmwareProgress,
  pricingGroup,
  roamingTariff,
  smartChargingPush,
  smartChargingTemplate,
  tariff,
  token,
};

describe('Detail page headers on phones', () => {
  for (const [name, source] of Object.entries(PAGES)) {
    it(`${name} wraps its title row instead of pushing Prev and Next off the screen`, () => {
      expect(source).toContain('<div className="flex flex-wrap items-center gap-x-4 gap-y-2">');
      expect(source).not.toContain(
        '<div className="flex items-center gap-4">\n        <BackButton',
      );
      // The title shrinks and a long name breaks.
      expect(source).toMatch(/<h1 className="[^"]*wrap-anywhere"/);
      expect(source).toContain('min-w-0');
    });
  }
});
