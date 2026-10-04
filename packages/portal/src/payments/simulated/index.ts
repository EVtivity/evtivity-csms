// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderModule } from '../types';
import { SimulatedCardSetup } from './SimulatedCardSetup';
import { SimulatedGuestPayment } from './SimulatedGuestPayment';

const simulatedModule: PaymentProviderModule = {
  id: 'simulated',
  CardSetup: SimulatedCardSetup,
  GuestPayment: SimulatedGuestPayment,
};

export default simulatedModule;
