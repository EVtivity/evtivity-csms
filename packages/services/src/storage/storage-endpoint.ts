// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  BlockedDestinationError,
  createGuardedLookup,
  isNonPublicAddress,
  isPrivateUrl,
} from '@evtivity/lib';

/**
 * The endpoint of an S3-compatible provider (MinIO, Wasabi and the like). The
 * API signs requests to it with the stored access keys, so it must not name a
 * private or internal host unless an admin allowed that host
 * (`s3.allowedPrivateHosts`), the same rule as the OCSP and webhook allowlists.
 */

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

function hostOf(url: URL): string {
  return normalizeHost(url.hostname);
}

/**
 * An endpoint as it may be stored: the origin of an http(s) URL without
 * credentials, path, query or fragment. A public host must use https; a host in
 * `allowedPrivateHosts` may be private and use plain http (a MinIO on the
 * local network). Null when the value is refused. This is a syntactic check:
 * the client connects through createStorageRequestHandler, which also checks
 * the address the host resolves to.
 */
export function validateStorageEndpoint(
  value: unknown,
  allowedPrivateHosts: readonly string[],
): string | null {
  if (typeof value !== 'string') return null;
  const url = URL.parse(value.trim());
  if (url == null) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  const allowed = allowedPrivateHosts.includes(hostOf(url));
  if (!allowed && (url.protocol !== 'https:' || isPrivateUrl(url.href))) return null;
  return url.origin;
}

/** Refuses a private IP address host that is not allowed, before NodeHttpHandler sends. */
class GuardedHttpHandler extends NodeHttpHandler {
  constructor(
    private readonly allowedHosts: ReadonlySet<string>,
    options: ConstructorParameters<typeof NodeHttpHandler>[0],
  ) {
    super(options);
  }

  override handle(
    ...args: Parameters<NodeHttpHandler['handle']>
  ): ReturnType<NodeHttpHandler['handle']> {
    const host = normalizeHost(args[0].hostname);
    if (isIP(host) !== 0 && !this.allowedHosts.has(host) && isNonPublicAddress(host)) {
      return Promise.reject(new BlockedDestinationError(host, host));
    }
    return super.handle(...args);
  }
}

/**
 * The S3 client's request handler for a custom endpoint. A host name resolves
 * through createGuardedLookup, so a name that resolves to a private address is
 * refused unless it is allowed. Node does no lookup for an IP address host, so
 * the handler checks that address itself before sending. Virtual-hosted
 * requests go to `<bucket>.<host>`, so that name is allowed together with its
 * host.
 */
export function createStorageRequestHandler(
  bucket: string,
  allowedPrivateHosts: readonly string[],
): NodeHttpHandler {
  const allowed = [
    ...allowedPrivateHosts,
    ...allowedPrivateHosts.map((host) => `${bucket}.${host}`),
  ];
  const lookup = createGuardedLookup({ allowedPrivateHosts: allowed });
  return new GuardedHttpHandler(new Set(allowed), {
    httpAgent: new HttpAgent({ keepAlive: true, lookup }),
    httpsAgent: new HttpsAgent({ keepAlive: true, lookup }),
  });
}
