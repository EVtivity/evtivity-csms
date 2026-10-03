// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  // Decrypts *Enc settings (the Stripe secret key for the capture retry).
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
});

export type WorkerConfig = z.infer<typeof schema>;

export const config = schema.parse(process.env);
