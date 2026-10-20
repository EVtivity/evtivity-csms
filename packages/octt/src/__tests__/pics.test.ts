// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { getCsRegistry } from '../cs-registry.js';
import { getRegistry } from '../registry.js';
import {
  getNotApplicable,
  getPics,
  getTestProfiles,
  PICS_CSMS_V1_6,
  PICS_CSMS_V2_0_1,
  PICS_CSMS_V2_1,
  PICS_V1_6,
  PICS_V2_0_1,
  PICS_V2_1,
} from '../pics/index.js';
import type { Pics } from '../pics/index.js';
import { INFORMATIVE_CS_ONLY, INFORMATIVE_NOT_IN_PART5 } from '../pics/csms-v2_0_1.js';
import { OCPP201_CSMS_TEST_IDS } from '../ocpp201-csms-cases.js';

describe('PICS', () => {
  const testsBySut = { cs: getCsRegistry(), csms: getRegistry() };

  for (const pics of [
    PICS_V2_1,
    PICS_V2_0_1,
    PICS_V1_6,
    PICS_CSMS_V2_1,
    PICS_CSMS_V2_0_1,
    PICS_CSMS_V1_6,
  ]) {
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
            const itemIds =
              'anyOf' in p ? p.anyOf.map((o) => (typeof o === 'string' ? o : o.item)) : [p.item];
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
    expect(getPics('ocpp2.0.1', 'csms')).toBe(PICS_CSMS_V2_0_1);
    expect(getPics('ocpp2.0.1', 'cs')).toBe(PICS_V2_0_1);
  });

  it('applies an anyOf alternative that needs an item unsupported', () => {
    const pics: Pics = {
      sut: 'csms',
      version: 'ocpp2.0.1',
      items: {
        A: { id: 'A', description: 'a', supported: false, reason: 'no a' },
        Q: { id: 'Q', description: 'q', supported: true },
        R: { id: 'R', description: 'r', supported: false, reason: 'no r' },
      },
      testPrerequisites: {
        TC_X_CSMS: [{ anyOf: ['A', { item: 'R', requires: false }] }],
        TC_Y_CSMS: [{ anyOf: ['A', { item: 'Q', requires: false }] }],
      },
    };
    expect(getNotApplicable('TC_X_CSMS', 'ocpp2.0.1', 'csms', pics)).toBeNull();
    const na = getNotApplicable('TC_Y_CSMS', 'ocpp2.0.1', 'csms', pics);
    expect(na?.item).toBe('A | NOT Q');
    expect(na?.reason).toBe('PICS none of A, NOT Q holds: no a; q');
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

    it('applies the ISO 15118 contract certificate installation and update tests', () => {
      expect(PICS_CSMS_V2_1.items.ContractCertificateInstallationEV?.supported).toBe(true);
      for (const id of contractCertTests) {
        expect(getNotApplicable(id, 'ocpp2.1', 'csms'), id).toBeNull();
      }
    });

    it('keeps the certificate status and CA certificate tests applicable', () => {
      for (const id of ['TC_M_24_CSMS', 'TC_M_03_CSMS', 'TC_M_14_CSMS', 'TC_C_50_CSMS']) {
        expect(getNotApplicable(id, 'ocpp2.1', 'csms'), id).toBeNull();
      }
    });

    it('excludes no CSMS test', () => {
      const excluded = getRegistry()
        .filter((t) => getNotApplicable(t.id, t.version, 'csms') != null)
        .map((t) => t.id);
      expect(excluded).toEqual([]);
    });

    it('declares every OCPP 2.1 item supported', () => {
      for (const item of Object.values(PICS_CSMS_V2_1.items)) {
        expect(item.supported, item.id).toBe(true);
      }
    });

    it('declares every OCPP 2.0.1 Part 5 profile, feature and question supported', () => {
      for (const item of Object.values(PICS_CSMS_V2_0_1.items)) {
        expect(item.supported, item.id).toBe(true);
      }
    });

    it('declares every OCPP 1.6 row supported', () => {
      for (const item of Object.values(PICS_CSMS_V1_6.items)) {
        expect(item.supported, item.id).toBe(true);
      }
    });
  });

  describe('OCPP 2.0.1 CSMS certification profiles (Part 5 ed4 chapter 4)', () => {
    const profileOf = (id: string): string[] =>
      (getTestProfiles(id, 'ocpp2.0.1', 'csms') ?? []).map(
        (p) => `${p.profile}:${p.requirement === 'mandatory' ? 'M' : 'C'}`,
      );

    it('gives every 2.0.1 case an entry and no other case', () => {
      expect(Object.keys(PICS_CSMS_V2_0_1.profiles ?? {}).sort()).toEqual(
        [...OCPP201_CSMS_TEST_IDS].sort(),
      );
    });

    it('counts the profile cases of the CSMS column', () => {
      const counts: Record<string, number> = {};
      for (const id of OCPP201_CSMS_TEST_IDS) {
        for (const key of profileOf(id)) counts[key] = (counts[key] ?? 0) + 1;
      }
      expect(counts).toEqual({
        'Core:M': 104,
        'Core:C': 83,
        'AdvancedSecurity:M': 4,
        'SmartCharging:M': 21,
        'SmartCharging:C': 1,
        'ISO15118Support:M': 36,
        'ISO15118Support:C': 1,
      });
    });

    it('runs the 20 cases no profile requires as informative', () => {
      const informative = OCPP201_CSMS_TEST_IDS.filter((id) => profileOf(id).length === 0);
      expect(informative.sort()).toEqual(
        [...INFORMATIVE_CS_ONLY, ...INFORMATIVE_NOT_IN_PART5].sort(),
      );
      expect(INFORMATIVE_NOT_IN_PART5).toHaveLength(13);
      expect(INFORMATIVE_CS_ONLY).toHaveLength(7);
    });

    // Rows whose mark sits in one column only, read by its position against the
    // two-mark rows of the same page.
    it('reads the single-mark rows by their column', () => {
      for (const id of ['TC_B_14_CSMS', 'TC_K_02_CSMS', 'TC_M_12_CSMS', 'TC_N_09_CSMS']) {
        expect(profileOf(id), id).toEqual([]);
      }
      for (const id of ['TC_N_48_CSMS', 'TC_O_11_CSMS']) expect(profileOf(id), id).toEqual([]);
      expect(profileOf('TC_G_20_CSMS')).toEqual(['Core:M']);
      expect(profileOf('TC_K_15_CSMS')).toEqual(['SmartCharging:M']);
      expect(profileOf('TC_N_29_CSMS')).toEqual(['Core:M']);
      expect(profileOf('TC_N_34_CSMS')).toEqual(['Core:M']);
      expect(profileOf('TC_O_18_CSMS')).toEqual(['Core:C']);
    });

    it('lists both profiles of a case two profiles require', () => {
      expect(profileOf('TC_K_01_CSMS')).toEqual(['SmartCharging:M', 'ISO15118Support:M']);
      expect(profileOf('TC_K_10_CSMS')).toEqual(['SmartCharging:C', 'ISO15118Support:M']);
      expect(profileOf('TC_N_63_CSMS')).toEqual(['ISO15118Support:C']);
      expect(profileOf('TC_A_07_CSMS')).toEqual(['AdvancedSecurity:M']);
    });

    it('gives every conditional case its Part 5 condition, and no mandatory or informative case one', () => {
      for (const id of OCPP201_CSMS_TEST_IDS) {
        const conditional = profileOf(id).some((p) => p.endsWith(':C'));
        const mandatoryElsewhere = profileOf(id).some((p) => p.endsWith(':M'));
        const hasCondition = PICS_CSMS_V2_0_1.testPrerequisites[id] != null;
        expect(hasCondition, id).toBe(conditional);
        if (hasCondition && mandatoryElsewhere) expect(id).toBe('TC_K_10_CSMS');
      }
      expect(PICS_CSMS_V2_0_1.testPrerequisites['TC_B_30_CSMS']).toEqual([
        { anyOf: ['C-44', { item: 'AQ-16', requires: false }] },
      ]);
      expect(PICS_CSMS_V2_0_1.testPrerequisites['TC_D_08_CSMS']).toEqual([
        { item: 'LA-0', requires: true },
        { item: 'LA-2', requires: true },
      ]);
    });

    it('excludes no 2.0.1 case', () => {
      expect(
        OCPP201_CSMS_TEST_IDS.filter((id) => getNotApplicable(id, 'ocpp2.0.1', 'csms') != null),
      ).toEqual([]);
    });

    it('maps no profiles for the other CSMS versions', () => {
      expect(getTestProfiles('TC_A_01_CSMS', 'ocpp2.1', 'csms')).toBeNull();
      expect(() => getTestProfiles('TC_B_100_CSMS', 'ocpp2.0.1', 'csms')).toThrow(
        /no certification/,
      );
    });
  });
});
