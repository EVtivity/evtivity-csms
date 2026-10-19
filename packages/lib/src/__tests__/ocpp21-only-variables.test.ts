// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import {
  OCPP21_ONLY_COMPONENTS,
  OCPP21_ONLY_VARIABLES,
  isOcpp21OnlyVariable,
} from '../ocpp21-only-variables.js';
import * as lib from '../index.js';

describe('isOcpp21OnlyVariable', () => {
  it('matches a 2.1-only variable of a component 2.0.1 also has', () => {
    expect(isOcpp21OnlyVariable('TxCtrlr', 'ResumptionTimeout')).toBe(true);
    expect(isOcpp21OnlyVariable('SmartChargingCtrlr', 'SupportsFeature')).toBe(true);
  });

  it('matches every variable of a component only 2.1 has', () => {
    expect(isOcpp21OnlyVariable('V2XChargingCtrlr', 'Enabled')).toBe(true);
    expect(isOcpp21OnlyVariable('NetworkConfiguration', 'OcppInterface')).toBe(true);
  });

  it('does not match OCPP 2.0.1 or vendor variables', () => {
    expect(isOcpp21OnlyVariable('TxCtrlr', 'EVConnectionTimeOut')).toBe(false);
    expect(isOcpp21OnlyVariable('TariffCostCtrlr', 'Enabled')).toBe(false);
    expect(isOcpp21OnlyVariable('SecurityCtrlr', 'AllowSecurityProfileDowngrade')).toBe(false);
    expect(isOcpp21OnlyVariable('VendorCtrlr', 'Anything')).toBe(false);
  });

  it('lists each entry once, sorted, as Component.Variable', () => {
    expect([...OCPP21_ONLY_VARIABLES].sort()).toEqual(OCPP21_ONLY_VARIABLES);
    expect(new Set(OCPP21_ONLY_VARIABLES).size).toBe(OCPP21_ONLY_VARIABLES.length);
    expect([...OCPP21_ONLY_COMPONENTS].sort((a, b) => a.localeCompare(b))).toEqual(
      OCPP21_ONLY_COMPONENTS,
    );
    for (const entry of OCPP21_ONLY_VARIABLES) {
      expect(entry).toMatch(/^[A-Za-z0-9]+\.[A-Za-z0-9]+$/);
      expect(OCPP21_ONLY_COMPONENTS).not.toContain(entry.split('.')[0]);
    }
  });

  it('is exported from the package index', () => {
    expect(lib.isOcpp21OnlyVariable).toBe(isOcpp21OnlyVariable);
  });
});
