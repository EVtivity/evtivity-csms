// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getCsRegistry } from '../cs-registry.js';
import { getRegistry } from '../registry.js';
import {
  getNotApplicable,
  getPics,
  PICS_CSMS_V1_6,
  PICS_CSMS_V2_1,
  PICS_V1_6,
  PICS_V2_1,
} from '../pics/index.js';
import type { Pics } from '../pics/index.js';

describe('PICS', () => {
  const testsBySut = { cs: getCsRegistry(), csms: getRegistry() };

  for (const pics of [PICS_V2_1, PICS_V1_6, PICS_CSMS_V2_1, PICS_CSMS_V1_6]) {
    describe(`${pics.sut} ${pics.version}`, () => {
      it('every unsupported item states a reason', () => {
        for (const item of Object.values(pics.items)) {
          if (!item.supported) expect(item.reason, item.id).toBeTruthy();
          expect(item.description, item.id).toBeTruthy();
        }
      });

      it('item keys match item ids', () => {
        for (const [key, item] of Object.entries(pics.items)) {
          expect(item.id).toBe(key);
        }
      });

      it('every prerequisite names a registered test of this SUT and version and a known item', () => {
        const ids = new Set(
          testsBySut[pics.sut].filter((t) => t.version === pics.version).map((t) => t.id),
        );
        for (const [testId, prerequisites] of Object.entries(pics.testPrerequisites)) {
          expect(ids.has(testId), testId).toBe(true);
          expect(prerequisites.length, testId).toBeGreaterThan(0);
          for (const p of prerequisites) {
            const itemIds = 'anyOf' in p ? p.anyOf : [p.item];
            for (const id of itemIds) {
              expect(pics.items[id], `${testId} -> ${id}`).toBeDefined();
            }
          }
        }
      });
    });
  }

  it('selects the PICS by version and SUT', () => {
    expect(getPics('ocpp2.1', 'cs')).toBe(PICS_V2_1);
    expect(getPics('ocpp1.6', 'cs')).toBe(PICS_V1_6);
    expect(getPics('ocpp2.1', 'csms')).toBe(PICS_CSMS_V2_1);
    expect(getPics('ocpp1.6', 'csms')).toBe(PICS_CSMS_V1_6);
  });

  it('returns null for a test without prerequisites', () => {
    expect(getNotApplicable('TC_E_01_CS', 'ocpp2.1', 'cs')).toBeNull();
  });

  it('cites the unsupported item for a test that needs it', () => {
    const na = getNotApplicable('TC_Q_100_CS', 'ocpp2.1', 'cs');
    expect(na?.item).toBe('BidirectionalPowerTransfer');
    expect(na?.reason).toContain('BidirectionalPowerTransfer not supported');
  });

  it('cites the supported item for a test that needs a station without it', () => {
    const na = getNotApplicable('TC_B_28_CS', 'ocpp2.1', 'cs');
    expect(na?.item).toBe('C-13');
    expect(na?.reason).toContain('requires a station without it');
  });

  it('applies an anyOf condition when one item is supported, else cites all', () => {
    const pics: Pics = {
      sut: 'cs',
      version: 'ocpp2.1',
      items: {
        A: { id: 'A', description: 'a', supported: false, reason: 'no a' },
        B: { id: 'B', description: 'b', supported: true },
        C: { id: 'C', description: 'c', supported: false, reason: 'no c' },
      },
      testPrerequisites: {
        TC_X_CS: [{ anyOf: ['A', 'B'] }],
        TC_Y_CS: [{ anyOf: ['A', 'C'] }],
      },
    };
    expect(getNotApplicable('TC_X_CS', 'ocpp2.1', 'cs', pics)).toBeNull();
    const na = getNotApplicable('TC_Y_CS', 'ocpp2.1', 'cs', pics);
    expect(na?.item).toBe('A | C');
    expect(na?.reason).toContain('no a; no c');
  });

  it('applies a test whose prerequisites all hold', () => {
    const pics: Pics = {
      sut: 'cs',
      version: 'ocpp2.1',
      items: {
        A: { id: 'A', description: 'a', supported: true },
        B: { id: 'B', description: 'b', supported: false, reason: 'none' },
      },
      testPrerequisites: {
        TC_X_CS: [
          { item: 'A', requires: true },
          { item: 'B', requires: false },
        ],
      },
    };
    expect(getNotApplicable('TC_X_CS', 'ocpp2.1', 'cs', pics)).toBeNull();
  });

  it('throws on a prerequisite that names an unknown item', () => {
    const pics: Pics = {
      sut: 'cs',
      version: 'ocpp2.1',
      items: {},
      testPrerequisites: { TC_X_CS: [{ item: 'Missing', requires: true }] },
    };
    expect(() => getNotApplicable('TC_X_CS', 'ocpp2.1', 'cs', pics)).toThrow(
      /unknown item Missing/,
    );
  });

  describe('CSMS PICS', () => {
    const contractCertTests = ['TC_M_26_CSMS', 'TC_M_28_CSMS', 'TC_M_100_CSMS'];

    it('excludes the ISO 15118 contract certificate installation and update tests', () => {
      for (const id of contractCertTests) {
        const na = getNotApplicable(id, 'ocpp2.1', 'csms');
        expect(na?.item, id).toBe('ContractCertificateInstallationEV');
        expect(na?.reason, id).toContain('ContractCertificateInstallationEV not supported');
        expect(na?.reason, id).toContain('contract certificate provisioning');
      }
    });

    it('keeps the certificate status and CA certificate tests applicable', () => {
      for (const id of ['TC_M_24_CSMS', 'TC_M_03_CSMS', 'TC_M_14_CSMS', 'TC_C_50_CSMS']) {
        expect(getNotApplicable(id, 'ocpp2.1', 'csms'), id).toBeNull();
      }
    });

    it('excludes exactly the contract certificate tests', () => {
      const excluded = getRegistry()
        .filter((t) => getNotApplicable(t.id, t.version, 'csms') != null)
        .map((t) => t.id)
        .sort();
      expect(excluded).toEqual([...contractCertTests].sort());
    });

    it('declares every OCPP 1.6 row supported', () => {
      for (const item of Object.values(PICS_CSMS_V1_6.items)) {
        expect(item.supported, item.id).toBe(true);
      }
    });
  });
});
