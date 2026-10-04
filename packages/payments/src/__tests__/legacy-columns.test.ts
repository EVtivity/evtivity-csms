// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { stripeColumnValue, writesStripeColumns } from '../legacy-columns.js';

describe('legacy stripe_* column dual write', () => {
  it.each([['stripe'], ['simulated']])('writes ids of %s to the stripe_* columns', (id) => {
    expect(writesStripeColumns(id)).toBe(true);
    expect(stripeColumnValue(id, 'x_1')).toBe('x_1');
    expect(stripeColumnValue(id, null)).toBeNull();
  });

  it('never writes ids of another provider to the stripe_* columns', () => {
    expect(writesStripeColumns('adyen')).toBe(false);
    expect(stripeColumnValue('adyen', 'PSP123')).toBeNull();
  });
});
