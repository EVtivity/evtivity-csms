// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CallApiFn } from './types.js';

export type ApiResult = Awaited<ReturnType<CallApiFn>>;

/**
 * Calls a PnC route. The API caches pnc.enabled for up to 60 s, so a
 * PNC_DISABLED answer right after the runner enabled PnC is retried.
 */
export async function callPncApi(
  callApi: CallApiFn,
  method: Parameters<CallApiFn>[0],
  path: string,
  body?: Record<string, unknown>,
): Promise<ApiResult> {
  const deadline = Date.now() + 70_000;
  for (;;) {
    const res = await callApi(method, path, body);
    if (res.body['code'] !== 'PNC_DISABLED' || Date.now() > deadline) return res;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}
