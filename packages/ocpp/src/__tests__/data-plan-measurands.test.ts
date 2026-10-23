// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { OCPP201_MEASURANDS, OCPP21_MEASURANDS } from '@evtivity/lib';
import { MeasurandEnum as Measurand201 } from '../generated/v2_0_1/enums/MeasurandEnum.js';
import { MeasurandEnum as Measurand21 } from '../generated/v2_1/enums/MeasurandEnum.js';

// The data plan boot push filters 2.x measurand lists with the lib copies of
// the enums; they must match the generated schemas.
describe('data plan measurand lists', () => {
  it('match the generated OCPP 2.0.1 MeasurandEnumType', () => {
    expect([...OCPP201_MEASURANDS].sort()).toEqual(
      [...new Set(Object.values(Measurand201))].sort(),
    );
  });

  it('match the generated OCPP 2.1 MeasurandEnumType', () => {
    expect([...OCPP21_MEASURANDS].sort()).toEqual([...new Set(Object.values(Measurand21))].sort());
  });
});
