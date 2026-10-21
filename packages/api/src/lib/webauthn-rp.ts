// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/** The relying party of a WebAuthn ceremony: the ID the credential is bound to and the page origin. */
export interface WebauthnRelyingParty {
  rpId: string;
  origin: string;
}

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function isDomainName(value: string): boolean {
  if (value.length > 253) return false;
  return value.split('.').every((label) => HOST_LABEL.test(label));
}

/** An IPv4 or IPv6 literal (URL hostnames keep IPv6 in brackets); a numeric last label is never a domain. */
function isIpLiteral(host: string): boolean {
  if (host.includes(':') || host.startsWith('[')) return true;
  const last = host.slice(host.lastIndexOf('.') + 1);
  return /^\d+$/.test(last);
}

/** The host of an app URL, lowercased, or null when it is not an http(s) URL. */
function urlHost(url: string): string | null {
  const parsed = URL.parse(url);
  if (parsed == null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) return null;
  return parsed.hostname.toLowerCase();
}

/**
 * Why WEBAUTHN_RP_ID cannot serve the CSMS, or null when it can (or is unset).
 * WebAuthn accepts an RP ID equal to the page host or a parent domain of it,
 * without a scheme, a port or a path. Browsers refuse IP addresses and public
 * suffixes as an RP ID, so an IP literal (as the RP ID or the CSMS host) and a
 * single label other than localhost are refused here too.
 */
export function webauthnRpIdProblem(rpId: string | undefined, csmsUrl: string): string | null {
  if (rpId == null) return null;
  const id = rpId.trim().toLowerCase();
  if (!isDomainName(id)) return 'must be a domain name, without a scheme, port or path';
  if (isIpLiteral(id)) return 'must be a domain name, not an IP address';
  // A single label (com, intranet) is a public suffix or a bare host name, never a parent domain.
  if (!id.includes('.') && id !== 'localhost') {
    return 'must have at least two labels (example.com), or be localhost';
  }
  const host = urlHost(csmsUrl);
  if (host == null) return 'CSMS_URL is not an http(s) URL';
  if (isIpLiteral(host)) {
    return 'cannot be set while CSMS_URL is an IP address: passkeys need a domain name';
  }
  if (!hostUnder(host, id)) {
    return `must be the host of CSMS_URL (${host}) or a parent domain of it`;
  }
  return null;
}

/**
 * The operator relying party: WEBAUTHN_RP_ID when set, else the host of
 * CSMS_URL, and the CSMS origin. The API accepts operator ceremonies from that
 * origin only.
 */
export function operatorRelyingParty(
  rpIdSetting: string | undefined,
  csmsUrl: string,
): WebauthnRelyingParty {
  const parsed = new URL(csmsUrl);
  return {
    rpId: rpIdSetting != null ? rpIdSetting.trim().toLowerCase() : parsed.hostname.toLowerCase(),
    origin: parsed.origin,
  };
}

/** Whether a host is the RP ID or a subdomain of it. */
function hostUnder(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

/**
 * Whether WEBAUTHN_RP_ID also serves the portal: set, and the portal host or a
 * parent domain of it. Otherwise the portal uses its own host as its RP ID, so
 * drivers keep passkeys of the portal and operators of the CSMS.
 */
export function rpIdServesPortal(rpIdSetting: string | undefined, portalUrl: string): boolean {
  if (rpIdSetting == null) return false;
  const host = urlHost(portalUrl);
  return host != null && !isIpLiteral(host) && hostUnder(host, rpIdSetting.trim().toLowerCase());
}

/**
 * Whether browsers allow passkeys on the portal: its host is a domain name.
 * Browsers refuse an IP address as an RP ID, so a portal served on one has no passkeys.
 */
export function portalHostAllowsPasskeys(portalUrl: string): boolean {
  const host = urlHost(portalUrl);
  return host != null && !isIpLiteral(host);
}

/**
 * The driver relying party: WEBAUTHN_RP_ID when it is the portal host or a
 * parent domain of it, else the host of PORTAL_URL, and the portal origin. The
 * API accepts driver ceremonies from that origin only.
 */
export function driverRelyingParty(
  rpIdSetting: string | undefined,
  portalUrl: string,
): WebauthnRelyingParty {
  const parsed = new URL(portalUrl);
  return {
    rpId:
      rpIdSetting != null && rpIdServesPortal(rpIdSetting, portalUrl)
        ? rpIdSetting.trim().toLowerCase()
        : parsed.hostname.toLowerCase(),
    origin: parsed.origin,
  };
}
