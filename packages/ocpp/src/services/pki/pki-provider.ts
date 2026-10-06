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

/** A Get15118EVCertificateRequest (OCPP 2.1 M01, M02) forwarded to the provider. */
export interface ContractCertRequest {
  /** Database ID of the requesting charging station. */
  stationDbId: string | null;
  iso15118SchemaVersion: string;
  action: 'Install' | 'Update';
  /** Raw CertificateInstallationReq or CertificateUpdateReq from the EV, base64. */
  exiRequest: string;
  /** ISO 15118-20 only. */
  maximumContractCertificateChains?: number;
  /** ISO 15118-20 only. */
  prioritizedEMAIDs?: string[];
}

export interface ContractCertResult {
  status: 'Accepted' | 'Failed';
  exiResponse: string;
  /** ISO 15118-20: contracts still to deliver after this one (M01.FR.04, FR.07). */
  remainingContracts?: number;
}

export interface OcspResult {
  status: 'Accepted' | 'Failed';
  ocspResult: string;
  /**
   * Why a Failed request failed. The responder is the one the station names,
   * so the caller logs it at warn with the station (a provider has no station).
   */
  reason?: string;
}

export interface PkiProvider {
  /** `stationDbId` links a CSR queued for manual signing to its station. */
  signCsr(csr: string, certificateType: string, stationDbId: string | null): Promise<SignCsrResult>;
  getContractCertificate(request: ContractCertRequest): Promise<ContractCertResult>;
  getOcspStatus(ocspRequestData: OcspRequestData): Promise<OcspResult>;
  getRootCertificates(type: string): Promise<string[]>;
}
