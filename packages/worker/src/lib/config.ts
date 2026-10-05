// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';

const schema = z.object({
  // Decrypts *Enc settings (the Stripe secret key for the capture retry).
  SETTINGS_ENCRYPTION_KEY: z.string().min(1),
  // OCTT conformance runs started from the dashboard connect to the OCPP
  // server and call the API here. Helm and CDK set the in-cluster addresses.
  OCPP_SERVER_URL: z.string().url().default('ws://localhost:7103'),
  API_BASE_URL: z.string().url().default('http://localhost:7102'),
  // Allows the simulated (test) payment provider in this process (D-T1). Default:
  // on when NODE_ENV is development (or unset) or test, off otherwise.
  PAYMENTS_ALLOW_SIMULATED: z
    .enum(['true', 'false'])
    .default(
      ['development', 'test'].includes(process.env['NODE_ENV'] ?? 'development') ? 'true' : 'false',
    )
    .transform((v) => v === 'true'),
  // OCTT conformance runs started from the dashboard: the URL at which the OCPP
  // server reaches the Test System OCSP responder the worker starts for the run
  // (it listens on the URL's port on all interfaces). Unset or empty: the OCSP
  // tests (TC_C_50, TC_C_51, TC_C_52, TC_M_24) are skipped.
  OCTT_OCSP_RESPONDER_URL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().url().optional(),
  ),
});

export type WorkerConfig = z.infer<typeof schema>;

export const config = schema.parse(process.env);
