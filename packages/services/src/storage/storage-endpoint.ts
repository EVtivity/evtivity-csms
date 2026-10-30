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
  isUnroutableAddress,
  parseAllowedPrivateHosts,
} from '@evtivity/lib';

/**
 * The endpoint of an S3-compatible provider (MinIO, Wasabi and the like). The
 * API signs requests to it with the stored access keys, so it must not name a
 * private or internal host unless an admin allowed that host
 * (`s3.allowedPrivateHosts`), the same rule as the OCSP and webhook allowlists.
 * An allowed host may be private, never unroutable: link-local and cloud
 * metadata addresses (169.254.169.254, fd00:ec2::254), unspecified, multicast
 * and reserved addresses (`isUnroutableAddress`) are refused even when listed,
 * at save and when the connection opens (security review case 278).
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

/** Whether a host is an IP address no storage request may reach, listed or not. */
function isUnroutableIpHost(host: string): boolean {
  return isIP(host) !== 0 && isUnroutableAddress(host);
}

/**
 * The private hosts list as it may be stored: `parseAllowedPrivateHosts`
 * (trimmed, lowercased hostnames or IP addresses, at most
 * MAX_ALLOWED_PRIVATE_HOSTS), refusing an unroutable IP address. Null when the
 * value is refused.
 */
export function parseStorageAllowedPrivateHosts(value: unknown): string[] | null {
  const hosts = parseAllowedPrivateHosts(value);
  if (hosts == null) return null;
  return hosts.some((host) => isUnroutableIpHost(normalizeHost(host))) ? null : hosts;
}

/**
 * An endpoint as it may be stored: the origin of an http(s) URL without
 * credentials, path, query or fragment. A public host must use https; a host in
 * `allowedPrivateHosts` may be private and use plain http (a MinIO on the
 * local network). An unroutable IP address host is refused even when listed.
 * Null when the value is refused. This is a syntactic check:
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
  const host = hostOf(url);
  if (isUnroutableIpHost(host)) return null;
  const allowed = allowedPrivateHosts.includes(host);
  if (!allowed && (url.protocol !== 'https:' || isPrivateUrl(url.href))) return null;
  return url.origin;
}

/**
 * Refuses an IP address host before NodeHttpHandler sends: an unroutable one
 * always, a private one unless allowed.
 */
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
    const blocked = this.allowedHosts.has(host) ? isUnroutableAddress : isNonPublicAddress;
    if (isIP(host) !== 0 && blocked(host)) {
      return Promise.reject(new BlockedDestinationError(host, host));
    }
    return super.handle(...args);
  }
}

/**
 * The S3 client's request handler for a custom endpoint. A host name resolves
 * through createGuardedLookup, so a name that resolves to a private address is
 * refused unless it is allowed, and an allowed name that resolves to an
 * unroutable address (cloud metadata) is refused too. Node does no lookup for an IP address host, so
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
  const allowedSet = new Set(allowed.map(normalizeHost));
  const publicLookup = createGuardedLookup();
  const privateLookup = createGuardedLookup({ allowPrivateNetworks: true });
  const lookup = (...args: Parameters<typeof publicLookup>): void => {
    const pick = allowedSet.has(normalizeHost(args[0])) ? privateLookup : publicLookup;
    pick(...args);
  };
  return new GuardedHttpHandler(allowedSet, {
    httpAgent: new HttpAgent({ keepAlive: true, lookup }),
    httpsAgent: new HttpsAgent({ keepAlive: true, lookup }),
  });
}
