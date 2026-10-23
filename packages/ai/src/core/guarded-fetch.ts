// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The subpath keeps the lib logger (pino) out of the AI bundle.
import { safeFetch } from '@evtivity/lib/safe-fetch';

/**
 * The `fetch` every production adapter gets (`AiAdapterOptions.fetch`): the
 * operator sets the provider base URL, and the request carries the API key,
 * so the address the host resolves to is checked when the connection opens
 * (`safeFetch`), not only the URL text on save. A host that is or
 * resolves to a non-public address is refused, unless `allowPrivateNetworks`
 * (a development mock provider, the same switch as the base URL check);
 * unroutable addresses such as cloud metadata are refused always.
 */
export function createGuardedFetch(allowPrivateNetworks: boolean): typeof globalThis.fetch {
  const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const merged: RequestInit =
      input instanceof Request
        ? {
            method: input.method,
            headers: input.headers,
            body: input.body,
            signal: input.signal,
            ...init,
          }
        : (init ?? {});
    return safeFetch(url, {
      ...(merged as Parameters<typeof safeFetch>[1]),
      allowPrivateNetworks,
    }) as unknown as Promise<Response>;
  };
  return guarded;
}
