// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  // Decrypts *Enc settings (the Stripe secret key for the capture retry).
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  // Allows the simulated (test) payment provider in this process (D-T1). Default:
  // on when NODE_ENV is development (or unset) or test, off otherwise.
  PAYMENTS_ALLOW_SIMULATED: z
    .enum(['true', 'false'])
    .default(
      ['development', 'test'].includes(process.env['NODE_ENV'] ?? 'development') ? 'true' : 'false',
    )
    .transform((v) => v === 'true'),
});

export type WorkerConfig = z.infer<typeof schema>;

export const config = schema.parse(process.env);
