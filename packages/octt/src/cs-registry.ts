// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { CsOcppVersion, CsTestCase } from './cs-types.js';
import { OCPP201_CS_TEST_IDS, OCPP201_CS_TEST_NAMES } from './ocpp201-cs-cases.js';

// v2.1 CS test cases
import * as A from './tests/v2_1/cs/A-security/index.js';
import * as B from './tests/v2_1/cs/B-provisioning/index.js';
import * as C from './tests/v2_1/cs/C-authorization/index.js';
import * as D from './tests/v2_1/cs/D-local-authorization-list/index.js';
import * as E from './tests/v2_1/cs/E-transactions/index.js';
import * as F from './tests/v2_1/cs/F-remote-control/index.js';
import * as G from './tests/v2_1/cs/G-availability/index.js';
import * as H from './tests/v2_1/cs/H-reservation/index.js';
import * as I from './tests/v2_1/cs/I-tariff-and-cost/index.js';
import * as J from './tests/v2_1/cs/J-meter-values/index.js';
import * as K from './tests/v2_1/cs/K-smart-charging/index.js';
import * as L from './tests/v2_1/cs/L-firmware-management/index.js';
import * as M from './tests/v2_1/cs/M-certificate-management/index.js';
import * as N from './tests/v2_1/cs/N-diagnostics/index.js';
import * as O from './tests/v2_1/cs/O-display-message/index.js';
import * as P from './tests/v2_1/cs/P-data-transfer/index.js';
import * as Q from './tests/v2_1/cs/Q-bidirectional-power-transfer/index.js';
import * as R from './tests/v2_1/cs/R-der-control/index.js';
import * as S from './tests/v2_1/cs/S-battery-swapping/index.js';

// v1.6 CS test cases
import * as V16 from './tests/v1_6/cs/index.js';

function collectTests(...modules: Record<string, unknown>[]): CsTestCase[] {
  const tests: CsTestCase[] = [];
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (
        value != null &&
        typeof value === 'object' &&
        'id' in value &&
        'sut' in value &&
        (value as Record<string, unknown>)['sut'] === 'cs'
      ) {
        tests.push(value as CsTestCase);
      }
    }
  }
  return tests;
}

const BASE_CS_TESTS: CsTestCase[] = collectTests(
  A,
  B,
  C,
  D,
  E,
  F,
  G,
  H,
  I,
  J,
  K,
  L,
  M,
  N,
  O,
  P,
  Q,
  R,
  S,
  V16,
);

/**
 * The OCPP 2.0.1 CS cases: the 2.1 case of each id, run with the simulator as
 * an OCPP 2.0.1 station (the executor sets its protocol from the case version
 * and the case reads the version from its context).
 */
const OCPP201_CS_TESTS: CsTestCase[] = OCPP201_CS_TEST_IDS.map((id) => {
  const tc = BASE_CS_TESTS.find((t) => t.id === id && t.version === 'ocpp2.1');
  if (tc == null) throw new Error(`OCPP 2.0.1 CS case ${id} has no OCPP 2.1 case`);
  return { ...tc, version: 'ocpp2.0.1', name: OCPP201_CS_TEST_NAMES[id] ?? tc.name };
});

const ALL_CS_TESTS: CsTestCase[] = [...BASE_CS_TESTS, ...OCPP201_CS_TESTS];

const csKey = (version: CsOcppVersion, id: string): string => `${version}:${id}`;

const testIndex = new Map<string, CsTestCase>();

function buildIndex(): void {
  if (testIndex.size > 0) return;
  for (const tc of ALL_CS_TESTS) {
    testIndex.set(csKey(tc.version, tc.id), tc);
  }
}

export function getCsRegistry(): CsTestCase[] {
  return ALL_CS_TESTS;
}

/** A CS test case by id and version: 2.1 and 2.0.1 cases share ids. */
export function getCsTestById(id: string, version: CsOcppVersion): CsTestCase | undefined {
  buildIndex();
  return testIndex.get(csKey(version, id));
}
