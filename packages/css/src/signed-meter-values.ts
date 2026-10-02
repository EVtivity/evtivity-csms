// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

/** OCPP 2.1 SignedMeterValueType. */
export interface SignedMeterValue {
  signedMeterData: string;
  signingMethod: string;
  encodingMethod: string;
  publicKey?: string;
}

export interface MeterIdentity {
  vendorName: string;
  model: string;
  serialNumber: string;
  firmwareVersion: string;
}

/**
 * Reading context (OCPP ReadingContextEnumType, e.g. Transaction.Begin,
 * Sample.Clock), mapped to the OCMF reading type (TX).
 */
export type ReadingContext = string;

export const OCMF_ENCODING = 'OCMF';
export const OCMF_SIGNING_METHOD = 'ECDSA-secp256r1-SHA256';

function ocmfTx(context: ReadingContext): string {
  if (context === 'Transaction.Begin') return 'B';
  if (context === 'Transaction.End') return 'E';
  return 'T';
}

/**
 * The simulated energy meter's signing unit. Readings are encoded as OCMF
 * (`OCMF|<payload>|<signature>`) and signed with ECDSA secp256r1 / SHA-256.
 * The key pair lives as long as the simulator instance, like a meter that is
 * replaced when the simulator restarts.
 */
export class OcmfMeterSigner {
  private readonly privateKey: KeyObject;
  /**
   * Public key in the OCPP 2.1 J02.FR.23 recommended form
   * `oca:base64:asn1:<base64 SubjectPublicKeyInfo DER>`.
   */
  readonly publicKey: string;
  private pagination = 0;

  constructor(private readonly identity: MeterIdentity) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
    this.publicKey = `oca:base64:asn1:${spki.toString('base64')}`;
  }

  /** Sign one reading. `includePublicKey` false sends publicKey as "". */
  sign(
    reading: { value: number; measurand?: string | undefined; unit?: string | undefined },
    timestamp: string,
    context: ReadingContext,
    includePublicKey: boolean,
  ): SignedMeterValue {
    this.pagination++;
    const payload = JSON.stringify({
      FV: '1.0',
      GI: `${this.identity.vendorName} ${this.identity.model}`,
      GS: this.identity.serialNumber,
      GV: this.identity.firmwareVersion,
      PG: `T${String(this.pagination)}`,
      RD: [
        {
          TM: `${timestamp} S`,
          TX: ocmfTx(context),
          RV: reading.value,
          RI: reading.measurand ?? 'Energy.Active.Import.Register',
          RU: reading.unit ?? 'Wh',
          ST: 'G',
        },
      ],
    });
    const signature = sign('sha256', Buffer.from(payload), this.privateKey).toString('hex');
    const ocmf = `OCMF|${payload}|${JSON.stringify({ SA: OCMF_SIGNING_METHOD, SD: signature })}`;
    return {
      signedMeterData: Buffer.from(ocmf).toString('base64'),
      signingMethod: OCMF_SIGNING_METHOD,
      encodingMethod: OCMF_ENCODING,
      publicKey: includePublicKey ? this.publicKey : '',
    };
  }
}

/** Parse a J02.FR.23 public key (`oca:<encoding>:asn1:<key>`) or a bare base64 SPKI DER key. */
export function parseMeterPublicKey(publicKey: string): KeyObject {
  const parts = publicKey.split(':');
  let der: Buffer;
  if (parts.length === 4 && parts[0] === 'oca' && parts[2] === 'asn1') {
    const encoding = parts[1];
    const content = parts[3] ?? '';
    der = encoding === 'base16' ? Buffer.from(content, 'hex') : Buffer.from(content, 'base64');
  } else {
    der = Buffer.from(publicKey, 'base64');
  }
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** Verify OCMF signed meter data (base64) against a meter public key. */
export function verifyOcmfSignature(signedMeterData: string, publicKey: string): boolean {
  const ocmf = Buffer.from(signedMeterData, 'base64').toString('utf8');
  const first = ocmf.indexOf('|');
  const last = ocmf.lastIndexOf('|');
  if (!ocmf.startsWith('OCMF|') || first === last) return false;
  const payload = ocmf.slice(first + 1, last);
  const sig = JSON.parse(ocmf.slice(last + 1)) as { SA?: string; SD?: string };
  if (sig.SA !== OCMF_SIGNING_METHOD || sig.SD == null) return false;
  return verify(
    'sha256',
    Buffer.from(payload),
    parseMeterPublicKey(publicKey),
    Buffer.from(sig.SD, 'hex'),
  );
}
