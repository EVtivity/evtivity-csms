// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { desc } from 'drizzle-orm';
import { pkiCaCertificates, pkiCsrRequests, stationCertificates } from '@evtivity/database';
import { defineListSort } from '../list-sort.js';

/** The sortable columns of `GET /v1/pnc/ca-certificates` (`api/routes.md`, "List sorting"). */
export const caCertificateListSort = defineListSort(
  {
    certificateType: pkiCaCertificates.certificateType,
    subject: pkiCaCertificates.subject,
    issuer: pkiCaCertificates.issuer,
    validTo: pkiCaCertificates.validTo,
    status: pkiCaCertificates.status,
    source: pkiCaCertificates.source,
  },
  {
    tieBreaker: pkiCaCertificates.id,
    defaultOrder: [desc(pkiCaCertificates.createdAt), desc(pkiCaCertificates.id)],
  },
);

/** The sortable columns of `GET /v1/pnc/csr-requests`. */
export const csrRequestListSort = defineListSort(
  {
    certificateType: pkiCsrRequests.certificateType,
    status: pkiCsrRequests.status,
    createdAt: pkiCsrRequests.createdAt,
    source: pkiCsrRequests.providerReference,
  },
  {
    tieBreaker: pkiCsrRequests.id,
    defaultOrder: [desc(pkiCsrRequests.createdAt), desc(pkiCsrRequests.id)],
  },
);

/** The sortable columns of `GET /v1/pnc/station-certificates`. */
export const stationCertificateListSort = defineListSort(
  {
    certificateType: stationCertificates.certificateType,
    subject: stationCertificates.subject,
    serialNumber: stationCertificates.serialNumber,
    validFrom: stationCertificates.validFrom,
    validTo: stationCertificates.validTo,
    status: stationCertificates.status,
    source: stationCertificates.source,
  },
  {
    tieBreaker: stationCertificates.id,
    defaultOrder: [desc(stationCertificates.createdAt), desc(stationCertificates.id)],
  },
);
