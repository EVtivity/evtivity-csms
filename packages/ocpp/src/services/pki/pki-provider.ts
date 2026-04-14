// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export interface OcspRequestData {
  hashAlgorithm: string;
  issuerNameHash: string;
  issuerKeyHash: string;
  serialNumber: string;
  responderURL: string;
}

export interface SignCsrResult {
  certificateChain: string;
  providerReference: string;
}

export interface ContractCertResult {
  status: 'Accepted' | 'Failed';
  exiResponse: string;
}

export interface OcspResult {
  status: 'Accepted' | 'Failed';
  ocspResult: string;
}

export interface PkiProvider {
  signCsr(csr: string, certificateType: string): Promise<SignCsrResult>;
  getContractCertificate(exiRequest: string): Promise<ContractCertResult>;
  getOcspStatus(ocspRequestData: OcspRequestData): Promise<OcspResult>;
  getRootCertificates(type: string): Promise<string[]>;
}
