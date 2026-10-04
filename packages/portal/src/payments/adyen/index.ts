// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderModule } from '../types';
import { AdyenCardSetup } from './AdyenCardSetup';
import { AdyenGuestPayment } from './AdyenGuestPayment';

const adyenModule: PaymentProviderModule = {
  id: 'adyen',
  CardSetup: AdyenCardSetup,
  GuestPayment: AdyenGuestPayment,
};

export default adyenModule;
