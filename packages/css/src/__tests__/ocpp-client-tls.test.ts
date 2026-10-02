// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import crypto, { webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as x509 from '@peculiar/x509';
import { WebSocketServer } from 'ws';
import {
  OcppClient,
  checkCentralSystemIdentity,
  isServerCertificateError,
  resolveVerifyServerCertificate,
} from '../ocpp-client.js';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const DAY = 24 * 60 * 60 * 1000;

interface Issued {
  cert: x509.X509Certificate;
  keys: CryptoKeyPair;
  pem: string;
  keyPem: string;
}

async function issue(
  subject: string,
  issuer: Issued | null,
  dnsNames: string[] = [],
): Promise<Issued> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])) as CryptoKeyPair;
  const ca = issuer == null;
  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(ca, undefined, true),
    new x509.KeyUsagesExtension(
      ca ? x509.KeyUsageFlags.keyCertSign : x509.KeyUsageFlags.digitalSignature,
      true,
    ),
  ];
  if (dnsNames.length > 0) {
    extensions.push(
      new x509.SubjectAlternativeNameExtension(
        dnsNames.map((value) => ({ type: 'dns' as const, value })),
      ),
    );
  }
  const common = {
    serialNumber: crypto
      .randomBytes(8)
      .toString('hex')
      .replace(/^[89a-f]/, '1'),
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + DAY),
    signingAlgorithm: ALG,
    extensions,
  };
  const cert =
    issuer == null
      ? await x509.X509CertificateGenerator.createSelfSigned({ ...common, name: subject, keys })
      : await x509.X509CertificateGenerator.create({
          ...common,
          subject,
          issuer: issuer.cert.subject,
          publicKey: keys.publicKey,
          signingKey: issuer.keys.privateKey,
        });
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  return { cert, keys, pem: cert.toString('pem'), keyPem };
}

let root: Issued;
let valid: Issued;
let untrusted: Issued;
let wildcard: Issued;
let wrongHost: Issued;

beforeAll(async () => {
  root = await issue('CN=Test CS Root', null);
  const otherRoot = await issue('CN=Other Root', null);
  valid = await issue('CN=localhost', root, ['localhost']);
  untrusted = await issue('CN=localhost', otherRoot, ['localhost']);
  wildcard = await issue('CN=localhost', root, ['localhost', '*.localhost']);
  wrongHost = await issue('CN=other.example', root, ['other.example']);
});

const servers: Server[] = [];
const clients: OcppClient[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const c of clients.splice(0)) c.disconnect();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function startServer(server: Issued): Promise<string> {
  const https = createServer({ cert: `${server.pem}\n${root.pem}`, key: server.keyPem });
  new WebSocketServer({ server: https, handleProtocols: (p) => [...p][0] ?? false });
  servers.push(https);
  await new Promise<void>((resolve) => https.listen(0, '127.0.0.1', resolve));
  const addr = https.address();
  if (addr == null || typeof addr === 'string') throw new Error('no address');
  return `wss://localhost:${String(addr.port)}`;
}

function client(
  serverUrl: string,
  opts: { protocol?: 'ocpp1.6' | 'ocpp2.1'; verify?: boolean } = {},
): OcppClient {
  const c = new OcppClient({
    serverUrl,
    stationId: 'TLS-TEST',
    ocppProtocol: opts.protocol ?? 'ocpp1.6',
    securityProfile: 2,
    password: 'password-1234567890',
    caCert: root.pem,
    ...(opts.verify != null ? { verifyServerCertificate: opts.verify } : {}),
  });
  clients.push(c);
  return c;
}

async function connectOutcome(c: OcppClient): Promise<string> {
  try {
    await c.connect();
    return 'connected';
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

describe('resolveVerifyServerCertificate', () => {
  it('verifies unless disabled explicitly', () => {
    expect(resolveVerifyServerCertificate(undefined, undefined)).toBe(true);
    expect(resolveVerifyServerCertificate(undefined, '')).toBe(true);
    expect(resolveVerifyServerCertificate(undefined, 'true')).toBe(true);
    expect(resolveVerifyServerCertificate(undefined, 'yes')).toBe(true);
    expect(resolveVerifyServerCertificate(undefined, 'false')).toBe(false);
    expect(resolveVerifyServerCertificate(undefined, ' FALSE ')).toBe(false);
    expect(resolveVerifyServerCertificate(undefined, '0')).toBe(false);
    expect(resolveVerifyServerCertificate(true, 'false')).toBe(true);
    expect(resolveVerifyServerCertificate(false, 'true')).toBe(false);
  });
});

describe('checkCentralSystemIdentity', () => {
  const peer = (cn: unknown, alt?: string): PeerCertificate =>
    ({
      subject: cn === undefined ? undefined : { CN: cn },
      subjectaltname: alt,
    }) as unknown as PeerCertificate;

  it('returns the standard host name error first', () => {
    expect(
      checkCentralSystemIdentity('localhost', peer('other.example', 'DNS:other.example')),
    ).toBeInstanceOf(Error);
  });

  it('refuses a wildcard name even when the host name matches', () => {
    const err = checkCentralSystemIdentity(
      'localhost',
      peer('localhost', 'DNS:localhost, DNS:*.localhost'),
    );
    expect((err as { code?: string } | undefined)?.code).toBe('ERR_TLS_CERT_WILDCARD');
  });

  it('accepts a matching name and tolerates a certificate without a subject', () => {
    expect(
      checkCentralSystemIdentity('localhost', peer('localhost', 'DNS:localhost')),
    ).toBeUndefined();
    expect(
      checkCentralSystemIdentity('localhost', peer(undefined, 'DNS:localhost')),
    ).toBeUndefined();
  });
});

describe('OcppClient server certificate verification', () => {
  it('verifies by default and reports a refused certificate', async () => {
    vi.stubEnv('TLS_REJECT_UNAUTHORIZED', undefined);
    const url = await startServer(untrusted);
    const c = client(url);
    const rejected = vi.fn();
    c.setServerCertificateRejectedHandler(rejected);
    const outcome = await connectOutcome(c);
    expect(isServerCertificateError({ code: outcome })).toBe(true);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('connects to a trusted server certificate', async () => {
    const url = await startServer(valid);
    expect(await connectOutcome(client(url))).toBe('connected');
  });

  it('skips verification only when disabled explicitly', async () => {
    const url = await startServer(untrusted);
    expect(await connectOutcome(client(url, { verify: false }))).toBe('connected');
    vi.stubEnv('TLS_REJECT_UNAUTHORIZED', 'false');
    expect(await connectOutcome(client(url))).toBe('connected');
    vi.stubEnv('TLS_REJECT_UNAUTHORIZED', 'true');
    expect(await connectOutcome(client(url))).not.toBe('connected');
  });

  it('refuses a host name mismatch', async () => {
    const url = await startServer(wrongHost);
    expect(await connectOutcome(client(url))).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
    expect(await connectOutcome(client(url, { protocol: 'ocpp2.1' }))).toBe(
      'ERR_TLS_CERT_ALTNAME_INVALID',
    );
  });

  it('refuses a wildcard certificate for both OCPP versions', async () => {
    const url = await startServer(wildcard);
    expect(await connectOutcome(client(url))).toBe('ERR_TLS_CERT_WILDCARD');
    expect(await connectOutcome(client(url, { protocol: 'ocpp2.1' }))).toBe(
      'ERR_TLS_CERT_WILDCARD',
    );
  });
});
