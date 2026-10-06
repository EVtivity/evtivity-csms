// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  webcrypto,
  type KeyObject,
} from 'node:crypto';
import { encode as cborEncode } from 'cbor-x';
import * as x509 from '@peculiar/x509';

// The production code pins the Apple App Attestation root. The test swaps the
// root PEM (the only string the code passes to X509Certificate) for a test root
// so a full chain built here can reach the checks after the chain.
const holder = vi.hoisted(() => ({ rootPem: null as string | null }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  class TestX509Certificate extends actual.X509Certificate {
    constructor(input: string | Buffer) {
      super(typeof input === 'string' && holder.rootPem != null ? holder.rootPem : input);
    }
  }
  return { ...actual, X509Certificate: TestX509Certificate };
});

const googleMocks = vi.hoisted(() => ({
  request: vi.fn(),
  ctorArgs: [] as unknown[],
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(opts: unknown) {
      googleMocks.ctorArgs.push(opts);
    }
    getClient() {
      return Promise.resolve({ request: googleMocks.request });
    }
  },
}));

import { verifyAssertion, verifyRegistration } from '../lib/device-attestation/app-attest.js';
import { verifyPlayIntegrity } from '../lib/device-attestation/play-integrity.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const CFG = {
  teamId: 'TEAM123',
  bundleId: 'com.evtivity.app',
  environment: 'development' as const,
};
const CHALLENGE = 'challenge-abc';
const NONCE_OID = '1.2.840.113635.100.8.2';

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

const rpIdHash = sha256(Buffer.from(`${CFG.teamId}.${CFG.bundleId}`));

async function genKeys(): Promise<CryptoKeyPair> {
  return (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
}

interface Ca {
  keys: CryptoKeyPair;
  cert: x509.X509Certificate;
}

async function makeRoot(name: string): Promise<Ca> {
  const keys = await genKeys();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { keys, cert };
}

async function issue(
  issuer: Ca,
  subject: string,
  publicKey: CryptoKey,
  extensions: x509.Extension[] = [],
): Promise<x509.X509Certificate> {
  return x509.X509CertificateGenerator.create({
    serialNumber: '02',
    subject: `CN=${subject}`,
    issuer: issuer.cert.subject,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: ALG,
    publicKey,
    signingKey: issuer.keys.privateKey,
    extensions,
  });
}

function nonceExt(nonce: Buffer): x509.Extension {
  // SEQUENCE { [1] EXPLICIT OCTET STRING (32 bytes) }
  const value = Buffer.concat([Buffer.from([0x30, 0x24, 0xa1, 0x22, 0x04, 0x20]), nonce]);
  return new x509.Extension(NONCE_OID, false, value);
}

function authDataFor(opts: {
  rpId?: Buffer;
  flags?: number;
  signCount?: number;
  credentialId?: Buffer;
}): Buffer {
  const signCount = Buffer.alloc(4);
  signCount.writeUInt32BE(opts.signCount ?? 0);
  const cred = opts.credentialId ?? Buffer.alloc(32);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(cred.length);
  return Buffer.concat([
    opts.rpId ?? rpIdHash,
    Buffer.from([opts.flags ?? 0x40]),
    signCount,
    Buffer.alloc(16),
    credLen,
    cred,
  ]);
}

let root: Ca;
let intermediate: Ca;
let otherRoot: Ca;
let leafKeys: CryptoKeyPair;
let leafPubHash: Buffer;

beforeAll(async () => {
  root = await makeRoot('Test Attest Root');
  otherRoot = await makeRoot('Other Root');
  const interKeys = await genKeys();
  intermediate = {
    keys: interKeys,
    cert: await issue(root, 'Test Attest CA', interKeys.publicKey, [
      new x509.BasicConstraintsExtension(true, undefined, true),
    ]),
  };
  leafKeys = await genKeys();
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', leafKeys.publicKey));
  leafPubHash = sha256(spki);
});

afterEach(() => {
  holder.rootPem = null;
  vi.useRealTimers();
});

async function attestation(opts: {
  authData?: Buffer;
  challenge?: string;
  ext?: x509.Extension | null;
  fmt?: string;
  chain?: (leaf: x509.X509Certificate) => Buffer[];
}): Promise<string> {
  const authData = opts.authData ?? authDataFor({ credentialId: leafPubHash });
  const nonce = sha256(authData, sha256(Buffer.from(opts.challenge ?? CHALLENGE)));
  const ext = opts.ext === undefined ? nonceExt(nonce) : opts.ext;
  const leaf = await issue(intermediate, 'leaf', leafKeys.publicKey, ext == null ? [] : [ext]);
  const x5c = opts.chain
    ? opts.chain(leaf)
    : [Buffer.from(leaf.rawData), Buffer.from(intermediate.cert.rawData)];
  return Buffer.from(
    cborEncode({ fmt: opts.fmt ?? 'apple-appattest', attStmt: { x5c }, authData }),
  ).toString('base64');
}

const keyId = (): string => leafPubHash.toString('base64');

describe('verifyRegistration with a full test chain', () => {
  it('accepts a valid attestation and returns the leaf public key', async () => {
    holder.rootPem = root.cert.toString('pem');
    const res = verifyRegistration(await attestation({}), keyId(), CHALLENGE, CFG);
    expect(res.ok).toBe(true);
    expect(res.signCount).toBe(0);
    expect(res.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
  });

  it('rejects a format other than apple-appattest', async () => {
    holder.rootPem = root.cert.toString('pem');
    const res = verifyRegistration(await attestation({ fmt: 'packed' }), keyId(), CHALLENGE, CFG);
    expect(res).toEqual({ ok: false });
  });

  it('rejects a chain without an intermediate', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({ chain: (leaf) => [Buffer.from(leaf.rawData)] });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a leaf the intermediate did not sign', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({
      chain: (leaf) => [Buffer.from(leaf.rawData), Buffer.from(otherRoot.cert.rawData)],
    });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects an intermediate the pinned root did not sign', async () => {
    holder.rootPem = otherRoot.cert.toString('pem');
    const res = verifyRegistration(await attestation({}), keyId(), CHALLENGE, CFG);
    expect(res).toEqual({ ok: false });
  });

  it('rejects certificates outside their validity window', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({});
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a nonce computed for another challenge', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({ challenge: 'other-challenge' });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a leaf without the nonce extension', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({ ext: null });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a nonce extension without a 32-byte octet string', async () => {
    holder.rootPem = root.cert.toString('pem');
    const bad = new x509.Extension(NONCE_OID, false, Buffer.from([0x30, 0x03, 0x04, 0x01, 0x00]));
    const att = await attestation({ ext: bad });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects authData without attested credential data', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({
      authData: authDataFor({ flags: 0x00, credentialId: leafPubHash }),
    });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a keyId that is not the leaf public key hash', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({});
    const wrong = Buffer.alloc(32, 7).toString('base64');
    expect(verifyRegistration(att, wrong, CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects an rpIdHash for another app', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({
      authData: authDataFor({ rpId: Buffer.alloc(32, 1), credentialId: leafPubHash }),
    });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });

  it('rejects a registration whose counter is not zero', async () => {
    holder.rootPem = root.cert.toString('pem');
    const att = await attestation({
      authData: authDataFor({ signCount: 1, credentialId: leafPubHash }),
    });
    expect(verifyRegistration(att, keyId(), CHALLENGE, CFG)).toEqual({ ok: false });
  });
});

describe('verifyAssertion with a real key', () => {
  let privateKey: KeyObject;
  let publicKeyPem: string;

  beforeAll(() => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    privateKey = pair.privateKey;
    publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  });

  function assertion(authData: Buffer, challenge = CHALLENGE, signer = privateKey): string {
    const nonce = sha256(authData, sha256(Buffer.from(challenge)));
    const signature = cryptoSign('sha256', nonce, signer);
    return Buffer.from(cborEncode({ signature, authenticatorData: authData })).toString('base64');
  }

  const assertionAuthData = (signCount: number, rpId = rpIdHash): Buffer => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount);
    return Buffer.concat([rpId, Buffer.from([0x01]), counter]);
  };

  it('accepts a signed assertion with a higher counter', () => {
    const res = verifyAssertion(assertion(assertionAuthData(5)), CHALLENGE, publicKeyPem, 4, CFG);
    expect(res).toEqual({ ok: true, newSignCount: 5 });
  });

  it('rejects a signature over another challenge', () => {
    const res = verifyAssertion(
      assertion(assertionAuthData(5), 'other'),
      CHALLENGE,
      publicKeyPem,
      4,
      CFG,
    );
    expect(res).toEqual({ ok: false });
  });

  it('rejects a signature from another key', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const res = verifyAssertion(
      assertion(assertionAuthData(5), CHALLENGE, other),
      CHALLENGE,
      publicKeyPem,
      4,
      CFG,
    );
    expect(res).toEqual({ ok: false });
  });

  it('rejects an assertion for another app id', () => {
    const res = verifyAssertion(
      assertion(assertionAuthData(5, Buffer.alloc(32, 9))),
      CHALLENGE,
      publicKeyPem,
      4,
      CFG,
    );
    expect(res).toEqual({ ok: false });
  });

  it('rejects a replayed counter equal to the stored one', () => {
    const res = verifyAssertion(assertion(assertionAuthData(4)), CHALLENGE, publicKeyPem, 4, CFG);
    expect(res).toEqual({ ok: false });
  });
});

describe('verifyPlayIntegrity decode results', () => {
  const PI_CFG = {
    packageName: 'com.evtivity.app',
    serviceAccountJson: JSON.stringify({ client_email: 'sa@example.com', private_key: 'k' }),
    cloudProjectNumber: '123',
  };

  const goodPayload = () => ({
    requestDetails: { requestPackageName: 'com.evtivity.app', nonce: 'n-1' },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  });

  it('accepts a recognized app on an integral device and posts the token', async () => {
    googleMocks.request.mockResolvedValueOnce({ data: { tokenPayloadExternal: goodPayload() } });
    const res = await verifyPlayIntegrity('tok-1', 'n-1', PI_CFG);
    expect(res).toEqual({ ok: true });
    expect(googleMocks.request).toHaveBeenCalledWith({
      url: 'https://playintegrity.googleapis.com/v1/com.evtivity.app:decodeIntegrityToken',
      method: 'POST',
      data: { integrity_token: 'tok-1' },
    });
    expect(googleMocks.ctorArgs.at(-1)).toEqual({
      credentials: { client_email: 'sa@example.com', private_key: 'k' },
      scopes: ['https://www.googleapis.com/auth/playintegrity'],
    });
  });

  it('rejects a response without a payload', async () => {
    googleMocks.request.mockResolvedValueOnce({ data: {} });
    expect(await verifyPlayIntegrity('t', 'n-1', PI_CFG)).toEqual({ ok: false });
  });

  it('rejects a nonce mismatch', async () => {
    googleMocks.request.mockResolvedValueOnce({ data: { tokenPayloadExternal: goodPayload() } });
    expect(await verifyPlayIntegrity('t', 'n-2', PI_CFG)).toEqual({ ok: false });
  });

  it('rejects another package name', async () => {
    const p = goodPayload();
    p.requestDetails.requestPackageName = 'com.other';
    googleMocks.request.mockResolvedValueOnce({ data: { tokenPayloadExternal: p } });
    expect(await verifyPlayIntegrity('t', 'n-1', PI_CFG)).toEqual({ ok: false });
  });

  it('rejects an app Play does not recognize', async () => {
    const p = goodPayload();
    p.appIntegrity.appRecognitionVerdict = 'UNRECOGNIZED_VERSION';
    googleMocks.request.mockResolvedValueOnce({ data: { tokenPayloadExternal: p } });
    expect(await verifyPlayIntegrity('t', 'n-1', PI_CFG)).toEqual({ ok: false });
  });

  it('rejects a device without a device integrity verdict', async () => {
    const p = { ...goodPayload(), deviceIntegrity: {} };
    googleMocks.request.mockResolvedValueOnce({ data: { tokenPayloadExternal: p } });
    expect(await verifyPlayIntegrity('t', 'n-1', PI_CFG)).toEqual({ ok: false });
  });

  it('fails closed when the decode request throws', async () => {
    googleMocks.request.mockRejectedValueOnce(new Error('403'));
    expect(await verifyPlayIntegrity('t', 'n-1', PI_CFG)).toEqual({ ok: false });
  });
});
