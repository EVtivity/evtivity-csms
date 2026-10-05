// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { decodeRaw, encodeRaw, RecordWriter, Tag, type Iso15118Schema } from './codec.js';

export const ISO2_NAMESPACE = 'urn:iso:15118:2:2013:MsgDef';
export const ISO20_NAMESPACE = 'urn:iso:std:iso:15118:-20:CommonMessages';

/** XML signature algorithm identifiers ISO 15118-2 and -20 use. */
export const XmlDsig = {
  CANONICAL_EXI: 'http://www.w3.org/TR/canonical-exi/',
  ECDSA_SHA256: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  ECDSA_SHA512: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha512',
  SHA256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  SHA512: 'http://www.w3.org/2001/04/xmlenc#sha512',
} as const;

/** ISO 15118-2 responseCodeType values used for certificate messages. */
export const Iso2ResponseCode = {
  OK: 0,
  FAILED: 4,
  FAILED_CertificateExpired: 10,
  FAILED_SignatureError: 11,
  FAILED_NoCertificateAvailable: 12,
  FAILED_CertChainError: 13,
  FAILED_ContractCanceled: 15,
  FAILED_CertificateRevoked: 25,
} as const;

/** ISO 15118-20 responseCodeType values used for certificate messages. */
export const Iso20ResponseCode = {
  OK: 0,
  WARNING_CertificateValidationError: 9,
  WARNING_NoCertificateAvailable: 15,
  WARNING_NoContractMatchingPCIDFound: 16,
  FAILED: 21,
  FAILED_SignatureError: 37,
} as const;

export const Iso20EcdhCurve = { SECP521: 0, X448: 1 } as const;
export const Iso20Processing = { Finished: 0, Ongoing: 1 } as const;

export interface CertificateChain {
  id?: string;
  certificate: Buffer;
  subCertificates: Buffer[];
}

export interface RootCertificateId {
  issuerName: string;
  /** Serial number, unsigned big-endian hex. */
  serialNumber: string;
}

export interface DecodedReference {
  uri: string | null;
  transform: string | null;
  digestMethod: string;
  digestValue: Buffer;
}

export interface DecodedSignature {
  canonicalizationMethod: string;
  signatureMethod: string;
  references: DecodedReference[];
  signatureValue: Buffer;
  /** EXI encoding of SignedInfo, the bytes the signature covers. */
  signedInfo: Buffer;
}

export interface Iso2CertificateInstallationReq {
  type: 'CertificateInstallationReq';
  id: string;
  oemProvisioningCert: Buffer;
  rootCertificateIds: RootCertificateId[];
}

export interface Iso2CertificateUpdateReq {
  type: 'CertificateUpdateReq';
  id: string;
  contractChain: CertificateChain;
  emaid: string;
  rootCertificateIds: RootCertificateId[];
}

export interface IdValue<T> {
  id: string;
  value: T;
}

export interface Iso2CertificateRes {
  type: 'CertificateInstallationRes' | 'CertificateUpdateRes';
  responseCode: number;
  retryCounter?: number;
  saProvisioningChain: CertificateChain;
  contractChain: CertificateChain;
  encryptedPrivateKey: IdValue<Buffer>;
  dhPublicKey: IdValue<Buffer>;
  emaid: IdValue<string>;
}

export type Iso2Body =
  | Iso2CertificateInstallationReq
  | Iso2CertificateUpdateReq
  | Iso2CertificateRes;

export interface Iso20CertificateInstallationReq {
  type: 'CertificateInstallationReq';
  oemProvisioningChain: CertificateChain & { id: string };
  rootCertificateIds: RootCertificateId[];
  maximumContractCertificateChains: number;
  prioritizedEmaids: string[];
}

export interface Iso20EncryptedPrivateKey {
  kind: 'SECP521' | 'X448' | 'TPM';
  value: Buffer;
}

export interface Iso20CertificateInstallationRes {
  type: 'CertificateInstallationRes';
  responseCode: number;
  evseProcessing: number;
  cpsChain: CertificateChain;
  signedInstallationData: {
    id: string;
    contractChain: CertificateChain;
    ecdhCurve: number;
    dhPublicKey: Buffer;
    encryptedPrivateKey: Iso20EncryptedPrivateKey | null;
  };
  remainingContractCertificateChains: number;
}

export type Iso20Body = Iso20CertificateInstallationReq | Iso20CertificateInstallationRes;

interface DecodedBase {
  /** SessionID from the message header, lowercase hex. */
  sessionId: string;
  signature: DecodedSignature | null;
  /** EXI fragment encoding of every element a signature can reference, by Id. */
  fragments: Record<string, Buffer>;
}

export interface DecodedIso2Message extends DecodedBase {
  schema: 2;
  body: Iso2Body;
}

export interface DecodedIso20Message extends DecodedBase {
  schema: 20;
  /** Header TimeStamp (seconds since the Unix epoch). */
  timestamp: bigint;
  body: Iso20Body;
}

export type DecodedMessage = DecodedIso2Message | DecodedIso20Message;

// ------------------------------------------------------------- JSON mapping

type Json = Record<string, unknown>;

function b64(value: unknown): Buffer {
  return Buffer.from(typeof value === 'string' ? value : '', 'base64');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function chain(value: unknown): CertificateChain {
  const v = (value ?? {}) as Json;
  const out: CertificateChain = {
    certificate: b64(v['certificate']),
    subCertificates: arr(v['subCertificates']).map(b64),
  };
  if (typeof v['id'] === 'string') out.id = v['id'];
  return out;
}

function rootIds(value: unknown): RootCertificateId[] {
  return arr(value).map((entry) => {
    const v = entry as Json;
    return { issuerName: str(v['issuerName']), serialNumber: str(v['serialNumber']) };
  });
}

function idValue<T>(value: unknown, map: (v: unknown) => T): IdValue<T> {
  const v = (value ?? {}) as Json;
  return { id: str(v['id']), value: map(v['value']) };
}

function signature(value: unknown): DecodedSignature | null {
  if (value == null) return null;
  const v = value as Json;
  return {
    canonicalizationMethod: str(v['canonicalizationMethod']),
    signatureMethod: str(v['signatureMethod']),
    references: arr(v['references']).map((entry) => {
      const r = entry as Json;
      return {
        uri: typeof r['uri'] === 'string' ? r['uri'] : null,
        transform: typeof r['transform'] === 'string' ? r['transform'] : null,
        digestMethod: str(r['digestMethod']),
        digestValue: b64(r['digestValue']),
      };
    }),
    signatureValue: b64(v['signatureValue']),
    signedInfo: b64(v['signedInfo']),
  };
}

function fragments(value: unknown): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const [id, data] of Object.entries((value ?? {}) as Json)) out[id] = b64(data);
  return out;
}

function iso2Body(body: Json): { body: Iso2Body; fragments: Record<string, Buffer> } {
  const type = str(body['type']);
  const frags = fragments(body['fragments']);
  if (type === 'CertificateInstallationReq') {
    return {
      fragments: frags,
      body: {
        type,
        id: str(body['id']),
        oemProvisioningCert: b64(body['oemProvisioningCert']),
        rootCertificateIds: rootIds(body['rootCertificateIds']),
      },
    };
  }
  if (type === 'CertificateUpdateReq') {
    return {
      fragments: frags,
      body: {
        type,
        id: str(body['id']),
        contractChain: chain(body['contractChain']),
        emaid: str(body['emaid']),
        rootCertificateIds: rootIds(body['rootCertificateIds']),
      },
    };
  }
  const res: Iso2CertificateRes = {
    type: type === 'CertificateUpdateRes' ? 'CertificateUpdateRes' : 'CertificateInstallationRes',
    responseCode: num(body['responseCode']),
    saProvisioningChain: chain(body['saProvisioningChain']),
    contractChain: chain(body['contractChain']),
    encryptedPrivateKey: idValue(body['encryptedPrivateKey'], b64),
    dhPublicKey: idValue(body['dhPublicKey'], b64),
    emaid: idValue(body['emaid'], str),
  };
  if (typeof body['retryCounter'] === 'number') res.retryCounter = body['retryCounter'];
  return { body: res, fragments: frags };
}

function iso20Body(body: Json): { body: Iso20Body; fragments: Record<string, Buffer> } {
  const frags = fragments(body['fragments']);
  if (str(body['type']) === 'CertificateInstallationReq') {
    const oem = chain(body['oemProvisioningChain']);
    return {
      fragments: frags,
      body: {
        type: 'CertificateInstallationReq',
        oemProvisioningChain: { ...oem, id: oem.id ?? '' },
        rootCertificateIds: rootIds(body['rootCertificateIds']),
        maximumContractCertificateChains: num(body['maximumContractCertificateChains']),
        prioritizedEmaids: arr(body['prioritizedEmaids']).map(str),
      },
    };
  }
  const data = (body['signedInstallationData'] ?? {}) as Json;
  let encryptedPrivateKey: Iso20EncryptedPrivateKey | null = null;
  if (typeof data['secp521EncryptedPrivateKey'] === 'string') {
    encryptedPrivateKey = { kind: 'SECP521', value: b64(data['secp521EncryptedPrivateKey']) };
  } else if (typeof data['x448EncryptedPrivateKey'] === 'string') {
    encryptedPrivateKey = { kind: 'X448', value: b64(data['x448EncryptedPrivateKey']) };
  } else if (typeof data['tpmEncryptedPrivateKey'] === 'string') {
    encryptedPrivateKey = { kind: 'TPM', value: b64(data['tpmEncryptedPrivateKey']) };
  }
  return {
    fragments: frags,
    body: {
      type: 'CertificateInstallationRes',
      responseCode: num(body['responseCode']),
      evseProcessing: num(body['evseProcessing']),
      cpsChain: chain(body['cpsChain']),
      signedInstallationData: {
        id: str(data['id']),
        contractChain: chain(data['contractChain']),
        ecdhCurve: num(data['ecdhCurve']),
        dhPublicKey: b64(data['dhPublicKey']),
        encryptedPrivateKey,
      },
      remainingContractCertificateChains: num(body['remainingContractCertificateChains']),
    },
  };
}

function toDecoded(json: Json): DecodedMessage {
  const sessionId = str(json['sessionId']);
  const sig = signature(json['signature']);
  const body = (json['body'] ?? {}) as Json;
  if (json['schema'] === 20) {
    const mapped = iso20Body(body);
    return {
      schema: 20,
      sessionId,
      timestamp: BigInt(str(json['timestamp']) || '0'),
      signature: sig,
      body: mapped.body,
      fragments: mapped.fragments,
    };
  }
  const mapped = iso2Body(body);
  return { schema: 2, sessionId, signature: sig, body: mapped.body, fragments: mapped.fragments };
}

/** Decodes a raw ISO 15118 EXI message (V2G_Message for -2, the message element for -20). */
export function decodeMessage(schema: Iso15118Schema, exi: Uint8Array): DecodedMessage {
  return toDecoded(decodeRaw(schema, exi));
}

// ------------------------------------------------------------- encoding

export interface SignatureInput {
  signatureMethod: string;
  digestMethod: string;
  references: Array<{ uri: string; digestValue: Uint8Array }>;
  signatureValue: Uint8Array;
}

interface EncodeBase {
  /** SessionID, hex (up to 8 bytes). */
  sessionId: string;
  signature?: SignatureInput;
}

export type Iso2EncodeInput = EncodeBase & {
  schema: 2;
  body: Iso2Body;
};

export type Iso20EncodeInput = EncodeBase & {
  schema: 20;
  timestamp: bigint;
  body: Iso20Body;
};

export type EncodeInput = Iso2EncodeInput | Iso20EncodeInput;

export interface EncodeResult {
  exi: Buffer;
  /** EXI encoding of SignedInfo when a signature was given, else null. */
  signedInfo: Buffer | null;
  decoded: DecodedMessage;
}

const MSG_TYPE = {
  CertificateInstallationReq: 1,
  CertificateUpdateReq: 2,
  CertificateInstallationRes: 3,
  CertificateUpdateRes: 4,
} as const;

function writeRootIds(w: RecordWriter, ids: RootCertificateId[]): void {
  for (const id of ids) {
    w.string(Tag.ROOT_ISSUER, id.issuerName);
    w.bytes(
      Tag.ROOT_SERIAL,
      Buffer.from(
        id.serialNumber.length % 2 === 1 ? `0${id.serialNumber}` : id.serialNumber,
        'hex',
      ),
    );
  }
}

function writeIso2Body(w: RecordWriter, body: Iso2Body): void {
  w.u32(Tag.MSG_TYPE, MSG_TYPE[body.type]);
  if (body.type === 'CertificateInstallationReq') {
    w.string(Tag.BODY_ID, body.id);
    w.bytes(Tag.OEM_CERT, body.oemProvisioningCert);
    writeRootIds(w, body.rootCertificateIds);
    return;
  }
  if (body.type === 'CertificateUpdateReq') {
    w.string(Tag.BODY_ID, body.id);
    if (body.contractChain.id != null) w.string(Tag.CONTRACT_CHAIN_ID, body.contractChain.id);
    w.bytes(Tag.CONTRACT_CERT, body.contractChain.certificate);
    for (const sub of body.contractChain.subCertificates) w.bytes(Tag.CONTRACT_SUBCERT, sub);
    w.string(Tag.EMAID, body.emaid);
    writeRootIds(w, body.rootCertificateIds);
    return;
  }
  w.u32(Tag.RESPONSE_CODE, body.responseCode);
  w.bytes(Tag.SA_CERT, body.saProvisioningChain.certificate);
  for (const sub of body.saProvisioningChain.subCertificates) w.bytes(Tag.SA_SUBCERT, sub);
  if (body.contractChain.id != null) w.string(Tag.CONTRACT_CHAIN_ID, body.contractChain.id);
  w.bytes(Tag.CONTRACT_CERT, body.contractChain.certificate);
  for (const sub of body.contractChain.subCertificates) w.bytes(Tag.CONTRACT_SUBCERT, sub);
  w.string(Tag.ENC_KEY_ID, body.encryptedPrivateKey.id);
  w.bytes(Tag.ENC_KEY, body.encryptedPrivateKey.value);
  w.string(Tag.DH_ID, body.dhPublicKey.id);
  w.bytes(Tag.DH_KEY, body.dhPublicKey.value);
  w.string(Tag.EMAID_ID, body.emaid.id);
  w.string(Tag.EMAID, body.emaid.value);
  if (body.type === 'CertificateUpdateRes' && body.retryCounter != null) {
    w.u32(Tag.RETRY_COUNTER, body.retryCounter & 0xffff);
  }
}

function writeIso20Body(w: RecordWriter, body: Iso20Body): void {
  if (body.type === 'CertificateInstallationReq') {
    w.string(Tag.OEM_CHAIN_ID, body.oemProvisioningChain.id);
    w.bytes(Tag.OEM_CERT, body.oemProvisioningChain.certificate);
    for (const sub of body.oemProvisioningChain.subCertificates) w.bytes(Tag.OEM_SUBCERT, sub);
    writeRootIds(w, body.rootCertificateIds);
    w.u32(Tag.MAX_CHAINS, body.maximumContractCertificateChains);
    for (const emaid of body.prioritizedEmaids) w.string(Tag.PRIORITIZED_EMAID, emaid);
    return;
  }
  const data = body.signedInstallationData;
  w.u32(Tag.RESPONSE_CODE, body.responseCode);
  w.u32(Tag.EVSE_PROCESSING, body.evseProcessing);
  w.bytes(Tag.SA_CERT, body.cpsChain.certificate);
  for (const sub of body.cpsChain.subCertificates) w.bytes(Tag.SA_SUBCERT, sub);
  w.string(Tag.SIGNED_DATA_ID, data.id);
  w.bytes(Tag.CONTRACT_CERT, data.contractChain.certificate);
  for (const sub of data.contractChain.subCertificates) w.bytes(Tag.CONTRACT_SUBCERT, sub);
  w.u32(Tag.ECDH_CURVE, data.ecdhCurve);
  w.bytes(Tag.DH_KEY, data.dhPublicKey);
  if (data.encryptedPrivateKey != null) {
    const kinds = { SECP521: 0, X448: 1, TPM: 2 } as const;
    w.u32(Tag.ENC_KEY_KIND, kinds[data.encryptedPrivateKey.kind]);
    w.bytes(Tag.ENC_KEY, data.encryptedPrivateKey.value);
  }
  w.u32(Tag.REMAINING, body.remainingContractCertificateChains);
}

/** Encodes an ISO 15118 certificate message, optionally with a header signature. */
export function encodeMessage(input: EncodeInput): EncodeResult {
  const w = new RecordWriter();
  if (input.schema === 20) {
    w.u32(Tag.MSG_TYPE, input.body.type === 'CertificateInstallationReq' ? 1 : 3);
  }
  // The ISO 15118-2 message type is part of its body record.
  const sessionWriter = (): void => {
    w.bytes(Tag.SESSION_ID, Buffer.from(input.sessionId, 'hex'));
    if (input.schema === 20) w.u64(Tag.TIMESTAMP, input.timestamp);
    const sig = input.signature;
    if (sig != null) {
      for (const ref of sig.references) {
        w.string(Tag.SIG_REF_URI, ref.uri);
        w.bytes(Tag.SIG_REF_DIGEST, ref.digestValue);
      }
      w.string(Tag.SIG_METHOD, sig.signatureMethod);
      w.string(Tag.SIG_DIGEST_METHOD, sig.digestMethod);
      w.bytes(Tag.SIG_VALUE, sig.signatureValue);
    }
  };
  if (input.schema === 2) {
    writeIso2Body(w, input.body);
    sessionWriter();
  } else {
    sessionWriter();
    writeIso20Body(w, input.body);
  }
  const json = encodeRaw(input.schema, w.toBytes());
  return {
    exi: b64(json['exi']),
    signedInfo: typeof json['signedInfo'] === 'string' ? b64(json['signedInfo']) : null,
    decoded: toDecoded((json['decoded'] ?? {}) as Json),
  };
}
