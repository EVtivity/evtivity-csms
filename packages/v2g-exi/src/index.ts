// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export { ExiCodecError, type Iso15118Schema } from './codec.js';
export {
  decodeMessage,
  encodeMessage,
  ISO2_NAMESPACE,
  ISO20_NAMESPACE,
  Iso2ResponseCode,
  Iso20ResponseCode,
  Iso20EcdhCurve,
  Iso20Processing,
  XmlDsig,
  type CertificateChain,
  type DecodedIso2Message,
  type DecodedIso20Message,
  type DecodedMessage,
  type DecodedSignature,
  type EncodeInput,
  type EncodeResult,
  type IdValue,
  type Iso2Body,
  type Iso2CertificateInstallationReq,
  type Iso2CertificateRes,
  type Iso2CertificateUpdateReq,
  type Iso20Body,
  type Iso20CertificateInstallationReq,
  type Iso20CertificateInstallationRes,
  type Iso20EncryptedPrivateKey,
  type RootCertificateId,
  type SignatureInput,
} from './messages.js';
export {
  encodeSigned,
  verifySignature,
  ISO2_SIGNATURE,
  ISO20_SIGNATURE,
  type SignatureCheck,
  type SignatureProfile,
} from './signing.js';
export {
  concatKdf,
  decryptContractKeyIso2,
  decryptContractKeyIso20,
  encryptContractKeyIso2,
  encryptContractKeyIso20,
  iso20Aad,
  privateKeyFromScalar,
  privateScalar,
  publicKeyFromPoint,
  uncompressedPoint,
  type EncryptedContractKey,
} from './contract-key.js';
