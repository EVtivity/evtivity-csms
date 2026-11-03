// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { createAcPedestalKit } from '../site-layout-model-ac-pedestal';
import { createCurbPostKit } from '../site-layout-model-curb-post';

describe('curb post model', () => {
  it('is the one-port pedestal, under 5000 triangles', () => {
    const kit = createCurbPostKit();
    expect(kit.triangles).toBeLessThan(5000);
    expect(kit.triangles).toBe(createAcPedestalKit(1).triangles);
  });
});
