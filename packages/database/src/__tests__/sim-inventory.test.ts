// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', () => ({ db: {} }));

import {
  attachmentOutcome,
  changedSimFields,
  compareRecordIds,
  openSessionBeganAtOf,
  type AttachmentOutcomeInput,
  type OpenAttachmentView,
} from '../lib/sim-inventory.js';

describe('compareRecordIds', () => {
  it('compares integer ids by value, not as text', () => {
    expect(compareRecordIds('9', '10')).toBe(-1);
    expect(compareRecordIds('10', '9')).toBe(1);
    expect(compareRecordIds('100', '100')).toBe(0);
  });

  it('compares ids beyond the safe integer range exactly', () => {
    expect(compareRecordIds('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareRecordIds('18446744073709551615', '18446744073709551616')).toBe(-1);
  });

  it('treats leading zeros as the same number', () => {
    expect(compareRecordIds('007', '7')).toBe(0);
  });

  it('falls back to text order when either id is not an integer', () => {
    expect(compareRecordIds('a9', 'a10')).toBe(1);
    expect(compareRecordIds('10', 'abc')).toBe(-1);
    expect(compareRecordIds('-1', '2')).toBe(-1);
    expect(compareRecordIds('x', 'x')).toBe(0);
  });
});

const SIM = 'sim_aaaaaaaaaaaa';
const OTHER_SIM = 'sim_bbbbbbbbbbbb';

function elsewhere(overrides: Partial<OpenAttachmentView> = {}): OpenAttachmentView {
  return {
    id: 7,
    simId: SIM,
    stationId: 'sta_other',
    source: 'reported',
    confirmedAt: null,
    ...overrides,
  };
}

function atStation(simId: string): OpenAttachmentView {
  return {
    id: 3,
    simId,
    stationId: 'sta_this',
    source: 'reported',
    confirmedAt: null,
  };
}

function input(overrides: Partial<AttachmentOutcomeInput>): AttachmentOutcomeInput {
  return {
    simId: SIM,
    simActive: true,
    source: 'entered',
    withAllSites: true,
    stationOpen: null,
    simOpen: null,
    ...overrides,
  };
}

describe('attachmentOutcome', () => {
  it('changes nothing when the station already holds the SIM, confirmed or not', () => {
    for (const source of ['entered', 'reported', 'attached', 'imported'] as const) {
      expect(
        attachmentOutcome(
          input({ source, stationOpen: atStation(SIM), simOpen: { ...atStation(SIM) } }),
        ),
      ).toEqual({ kind: 'unchanged' });
    }
  });

  it('attaches a free SIM to a free station from every source', () => {
    for (const source of ['entered', 'reported', 'attached', 'imported'] as const) {
      for (const withAllSites of [true, false]) {
        expect(attachmentOutcome(input({ source, withAllSites }))).toEqual({
          kind: 'attach',
          replace: null,
          displace: null,
        });
      }
    }
  });

  it('replaces the station attachment of another SIM for an entered ICCID', () => {
    expect(attachmentOutcome(input({ stationOpen: atStation(OTHER_SIM) }))).toEqual({
      kind: 'attach',
      replace: 3,
      displace: null,
    });
    expect(
      attachmentOutcome(input({ withAllSites: false, stationOpen: atStation(OTHER_SIM) })),
    ).toEqual({ kind: 'attach', replace: 3, displace: null });
  });

  it('refuses a station with another SIM for a reported, attached or imported SIM', () => {
    for (const source of ['reported', 'attached', 'imported'] as const) {
      expect(attachmentOutcome(input({ source, stationOpen: atStation(OTHER_SIM) }))).toEqual({
        kind: 'station_has_sim',
      });
    }
  });

  it('displaces an unconfirmed reported attachment elsewhere for an all-site entry', () => {
    expect(attachmentOutcome(input({ simOpen: elsewhere() }))).toEqual({
      kind: 'attach',
      replace: null,
      displace: 7,
    });
    expect(
      attachmentOutcome(input({ stationOpen: atStation(OTHER_SIM), simOpen: elsewhere() })),
    ).toEqual({ kind: 'attach', replace: 3, displace: 7 });
  });

  it('never displaces for a site-restricted entry', () => {
    expect(attachmentOutcome(input({ withAllSites: false, simOpen: elsewhere() }))).toEqual({
      kind: 'attached_elsewhere',
      replace: null,
    });
    expect(
      attachmentOutcome(
        input({ withAllSites: false, stationOpen: atStation(OTHER_SIM), simOpen: elsewhere() }),
      ),
    ).toEqual({ kind: 'attached_elsewhere', replace: 3 });
  });

  it('never displaces a confirmed attachment', () => {
    for (const source of ['reported', 'entered', 'attached', 'imported'] as const) {
      expect(
        attachmentOutcome(input({ simOpen: elsewhere({ source, confirmedAt: new Date() }) })),
      ).toEqual({ kind: 'attached_elsewhere', replace: null });
    }
  });

  it('never displaces an entered, attached or imported attachment, even unconfirmed', () => {
    for (const source of ['entered', 'attached', 'imported'] as const) {
      expect(attachmentOutcome(input({ simOpen: elsewhere({ source }) }))).toEqual({
        kind: 'attached_elsewhere',
        replace: null,
      });
    }
  });

  it('never displaces for a reported, attached or imported SIM', () => {
    for (const source of ['reported', 'attached', 'imported'] as const) {
      for (const withAllSites of [true, false]) {
        expect(attachmentOutcome(input({ source, withAllSites, simOpen: elsewhere() }))).toEqual({
          kind: 'attached_elsewhere',
          replace: null,
        });
      }
    }
  });

  it('treats a SIM in a payment terminal as attached elsewhere', () => {
    const terminal = elsewhere({ stationId: null });
    expect(attachmentOutcome(input({ simOpen: terminal }))).toEqual({
      kind: 'attach',
      replace: null,
      displace: 7,
    });
    expect(attachmentOutcome(input({ source: 'attached', simOpen: terminal }))).toEqual({
      kind: 'attached_elsewhere',
      replace: null,
    });
  });
});

describe('attachmentOutcome for an inactive SIM', () => {
  it('attaches an inactive SIM from no source and displaces nothing for it', () => {
    for (const source of ['entered', 'reported', 'attached', 'imported'] as const) {
      for (const withAllSites of [true, false]) {
        for (const [stationOpen, simOpen] of [
          [null, null],
          [atStation(OTHER_SIM), null],
          [null, elsewhere()],
          [atStation(OTHER_SIM), elsewhere()],
        ] as const) {
          expect(
            attachmentOutcome(
              input({ simActive: false, source, withAllSites, stationOpen, simOpen }),
            ),
          ).toEqual({ kind: 'sim_inactive' });
        }
      }
    }
  });
});

describe('openSessionBeganAtOf', () => {
  it('reads a valid time', () => {
    expect(openSessionBeganAtOf('2026-10-22T08:00:00.000Z')).toEqual(
      new Date('2026-10-22T08:00:00.000Z'),
    );
  });

  it('stores null for a missing or invalid time, never throws', () => {
    expect(openSessionBeganAtOf(null)).toBeNull();
    expect(openSessionBeganAtOf('')).toBeNull();
    expect(openSessionBeganAtOf('not a date')).toBeNull();
    expect(openSessionBeganAtOf('2026-13-45T99:00:00Z')).toBeNull();
  });
});

describe('changedSimFields', () => {
  const before = { label: 'Kiosk', notes: null, imsi: '310260000000001' };

  it('returns only the fields that change', () => {
    expect(changedSimFields(before, { label: 'Kiosk', notes: 'spare' })).toEqual({
      notes: 'spare',
    });
    expect(changedSimFields(before, { label: null })).toEqual({ label: null });
  });

  it('returns nothing when no field changes', () => {
    expect(changedSimFields(before, {})).toEqual({});
    expect(
      changedSimFields(before, { label: 'Kiosk', notes: null, imsi: '310260000000001' }),
    ).toEqual({});
  });
});
