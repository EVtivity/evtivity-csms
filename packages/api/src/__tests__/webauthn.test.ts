// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  WebauthnVerificationError,
  buildAuthenticationOptions,
  buildRegistrationOptions,
  checkAuthentication,
  checkRegistration,
  newUserHandle,
  responseChallenge,
} from '../lib/webauthn.js';
import {
  driverRelyingParty,
  operatorRelyingParty,
  rpIdServesPortal,
  webauthnRpIdProblem,
} from '../lib/webauthn-rp.js';
import { SoftAuthenticator } from './helpers/soft-authenticator.js';

const rp = { rpId: 'csms.example.com', origin: 'https://csms.example.com' };

async function registered(authenticator: SoftAuthenticator) {
  const options = await buildRegistrationOptions({
    rp,
    rpName: 'Acme',
    userName: 'op@example.com',
    userDisplayName: 'Op',
    userHandle: newUserHandle(),
    exclude: [],
  });
  const response = authenticator.register(options, rp.origin);
  const stored = await checkRegistration(response, options.challenge, rp);
  return { options, response, stored };
}

describe('webauthnRpIdProblem', () => {
  it('accepts no value, the CSMS host and a parent domain of it', () => {
    expect(webauthnRpIdProblem(undefined, 'https://csms.example.com')).toBeNull();
    expect(webauthnRpIdProblem('csms.example.com', 'https://csms.example.com')).toBeNull();
    expect(webauthnRpIdProblem('Example.com', 'https://csms.example.com:8443')).toBeNull();
  });

  it('refuses another domain, a lookalike suffix, a scheme or a port', () => {
    expect(webauthnRpIdProblem('other.com', 'https://csms.example.com')).toMatch(/parent domain/);
    expect(webauthnRpIdProblem('ample.com', 'https://csms.example.com')).toMatch(/parent domain/);
    expect(webauthnRpIdProblem('https://example.com', 'https://csms.example.com')).toMatch(
      /domain name/,
    );
    expect(webauthnRpIdProblem('example.com:443', 'https://csms.example.com')).toMatch(
      /domain name/,
    );
  });

  it('refuses an IP address as the RP ID or as the CSMS host', () => {
    expect(webauthnRpIdProblem('192.168.1.10', 'https://192.168.1.10')).toMatch(/not an IP/);
    expect(webauthnRpIdProblem('example.com', 'https://192.168.1.10:7100')).toMatch(
      /CSMS_URL is an IP address/,
    );
    expect(webauthnRpIdProblem('example.com', 'https://[::1]:7100')).toMatch(
      /CSMS_URL is an IP address/,
    );
  });

  it('refuses a single label other than localhost', () => {
    expect(webauthnRpIdProblem('com', 'https://csms.example.com')).toMatch(/two labels/);
    expect(webauthnRpIdProblem('intranet', 'https://intranet')).toMatch(/two labels/);
    expect(webauthnRpIdProblem('localhost', 'http://localhost:7100')).toBeNull();
  });
});

describe('operatorRelyingParty', () => {
  it('uses the CSMS host and origin by default and the setting when given', () => {
    expect(operatorRelyingParty(undefined, 'https://CSMS.example.com:8443/app')).toEqual({
      rpId: 'csms.example.com',
      origin: 'https://csms.example.com:8443',
    });
    expect(operatorRelyingParty('example.com', 'https://csms.example.com').rpId).toBe(
      'example.com',
    );
  });
});

describe('driverRelyingParty', () => {
  it('uses the portal host and origin by default', () => {
    expect(driverRelyingParty(undefined, 'https://Portal.example.com:8443/x')).toEqual({
      rpId: 'portal.example.com',
      origin: 'https://portal.example.com:8443',
    });
    expect(driverRelyingParty(undefined, 'http://localhost:7101')).toEqual({
      rpId: 'localhost',
      origin: 'http://localhost:7101',
    });
  });

  it('shares WEBAUTHN_RP_ID only when it is a parent of the portal host', () => {
    expect(driverRelyingParty('example.com', 'https://portal.example.com').rpId).toBe(
      'example.com',
    );
    expect(rpIdServesPortal('example.com', 'https://portal.example.com')).toBe(true);
    // A parent of the CSMS host that is not one of the portal host: the portal keeps its own.
    expect(driverRelyingParty('csms.example.com', 'https://portal.example.com').rpId).toBe(
      'portal.example.com',
    );
    expect(driverRelyingParty('example.com', 'https://portal.example.org').rpId).toBe(
      'portal.example.org',
    );
    expect(driverRelyingParty('example.com', 'https://badexample.com').rpId).toBe('badexample.com');
    expect(rpIdServesPortal('example.com', 'https://10.0.0.5')).toBe(false);
    expect(rpIdServesPortal(undefined, 'https://portal.example.com')).toBe(false);
  });
});

describe('registration', () => {
  it('verifies a registration and returns what is stored', async () => {
    const authenticator = new SoftAuthenticator();
    const { options, stored } = await registered(authenticator);
    expect(options.rp).toEqual({ name: 'Acme', id: 'csms.example.com' });
    expect(options.attestation).toBe('none');
    expect(stored.credentialId).toBe(authenticator.credentialId);
    expect(stored.publicKey.length).toBeGreaterThan(60);
    expect(stored.deviceType).toBe('multiDevice');
    expect(stored.backedUp).toBe(true);
    expect(stored.transports).toEqual(['internal', 'hybrid']);
    expect(stored.userVerified).toBe(true);
  });

  it('refuses a response for another origin, RP ID or challenge', async () => {
    const authenticator = new SoftAuthenticator();
    const options = await buildRegistrationOptions({
      rp,
      rpName: 'Acme',
      userName: 'op@example.com',
      userDisplayName: 'Op',
      userHandle: newUserHandle(),
      exclude: [],
    });
    for (const overrides of [
      { origin: 'https://evil.example.net' },
      { rpId: 'evil.example.net' },
      { challenge: 'b3RoZXItY2hhbGxlbmdl' },
      { type: 'webauthn.get' },
    ]) {
      const response = authenticator.register(options, rp.origin, overrides);
      await expect(checkRegistration(response, options.challenge, rp)).rejects.toBeInstanceOf(
        WebauthnVerificationError,
      );
    }
  });

  it('reads the challenge a response answers', async () => {
    const authenticator = new SoftAuthenticator();
    const { options, response } = await registered(authenticator);
    expect(responseChallenge(response)).toBe(options.challenge);
    expect(responseChallenge({ response: { clientDataJSON: '%%%' } })).toBeNull();
    expect(responseChallenge({})).toBeNull();
  });
});

describe('authentication', () => {
  it('verifies an assertion and moves the counter up', async () => {
    const authenticator = new SoftAuthenticator();
    const { stored } = await registered(authenticator);
    const options = await buildAuthenticationOptions(rp, { userVerification: 'required' });
    expect(options.rpId).toBe('csms.example.com');
    expect(options.allowCredentials).toBeUndefined();
    const response = authenticator.authenticate(options, rp.origin, undefined);
    const result = await checkAuthentication(response, options.challenge, rp, stored, {
      requireUserVerification: true,
    });
    expect(result).toEqual({ newCounter: 1, userVerified: true, backedUp: true });
  });

  it('refuses a counter that goes backwards above 0', async () => {
    const authenticator = new SoftAuthenticator();
    const { stored } = await registered(authenticator);
    const options = await buildAuthenticationOptions(rp, { userVerification: 'preferred' });
    const response = authenticator.authenticate(options, rp.origin, undefined, { counter: 4 });
    await expect(
      checkAuthentication(
        response,
        options.challenge,
        rp,
        { ...stored, counter: 5 },
        {
          requireUserVerification: false,
        },
      ),
    ).rejects.toBeInstanceOf(WebauthnVerificationError);
  });

  it('refuses an assertion without user verification when it is required', async () => {
    const authenticator = new SoftAuthenticator({ userVerified: false, backedUp: false });
    const { stored } = await registered(authenticator);
    const options = await buildAuthenticationOptions(rp, { userVerification: 'required' });
    const response = authenticator.authenticate(options, rp.origin, undefined);
    await expect(
      checkAuthentication(response, options.challenge, rp, stored, {
        requireUserVerification: true,
      }),
    ).rejects.toBeInstanceOf(WebauthnVerificationError);
    // The same security key works as a second factor, where verification is not required.
    const again = await buildAuthenticationOptions(rp, {
      userVerification: 'preferred',
      allow: [{ credentialId: stored.credentialId, transports: ['usb'] }],
    });
    expect(again.allowCredentials).toEqual([
      { id: stored.credentialId, type: 'public-key', transports: ['usb'] },
    ]);
    const second = authenticator.authenticate(again, rp.origin, undefined);
    await expect(
      checkAuthentication(second, again.challenge, rp, stored, { requireUserVerification: false }),
    ).resolves.toMatchObject({ userVerified: false });
  });

  it('refuses another origin, RP ID, a signature from another key', async () => {
    const authenticator = new SoftAuthenticator();
    const { stored } = await registered(authenticator);
    const options = await buildAuthenticationOptions(rp, { userVerification: 'preferred' });
    for (const overrides of [{ origin: 'https://evil.example.net' }, { rpId: 'example.net' }]) {
      const response = authenticator.authenticate(options, rp.origin, undefined, overrides);
      await expect(
        checkAuthentication(response, options.challenge, rp, stored, {
          requireUserVerification: false,
        }),
      ).rejects.toBeInstanceOf(WebauthnVerificationError);
    }
    const other = new SoftAuthenticator({ credentialId: authenticator.credentialId });
    const forged = other.authenticate(options, rp.origin, undefined, { counter: 9 });
    await expect(
      checkAuthentication(forged, options.challenge, rp, stored, {
        requireUserVerification: false,
      }),
    ).rejects.toBeInstanceOf(WebauthnVerificationError);
  });
});
