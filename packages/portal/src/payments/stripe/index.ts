// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { PaymentProviderModule } from '../types';
import { StripeCardSetup } from './StripeCardSetup';
import { StripeGuestPayment } from './StripeGuestPayment';

const stripeModule: PaymentProviderModule = {
  id: 'stripe',
  CardSetup: StripeCardSetup,
  GuestPayment: StripeGuestPayment,
};

export default stripeModule;
