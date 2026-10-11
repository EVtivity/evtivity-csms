// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { SUPPORT_CASE_CATEGORIES } from '@evtivity/lib/driver-ai';
import { supportCaseCategoryEnum } from '../schema/support-cases.js';

describe('driver AI contract against the database schema', () => {
  it('mirrors the support case categories of the database enum', () => {
    expect([...SUPPORT_CASE_CATEGORIES]).toEqual(supportCaseCategoryEnum.enumValues);
  });
});
