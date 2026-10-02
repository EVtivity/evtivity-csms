// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { OcppVersion, SutType } from '../types.js';

/**
 * One line of a Protocol Implementation Conformance Statement (PICS): a
 * certification profile, an optional feature, a hardware feature, or a test
 * case prerequisite that decides which OCTT test cases apply to the Device
 * Under Test.
 *
 * Real OCTT loads the vendor PICS before a certification run and only runs
 * the test cases that the PICS makes applicable (OCTT test procedures 8.2 and
 * 8.3). Both runners mirror that: a test whose condition the Device Under
 * Test's PICS (the simulator for CS tests, the CSMS for CSMS tests) does not
 * meet is reported `notApplicable`, never run.
 */
export interface PicsItem {
  /**
   * Stable key. OCPP 2.1 uses the ids of OCPP 2.1 Part 5 (certification
   * profile names, optional features such as `C-13`, hardware features such
   * as `HFS-13`); test prerequisites without a Part 5 id use a descriptive
   * PascalCase key.
   */
  id: string;
  /** What the item declares, in the words of the PICS row or OCTT prerequisite. */
  description: string;
  /** Whether the Device Under Test declares the item (supports the feature / has the property). */
  supported: boolean;
  /** Why the Device Under Test does not declare the item. Required when `supported` is false. */
  reason?: string | undefined;
}

/**
 * A test condition. `{ item, requires: true }` needs the item supported,
 * `{ item, requires: false }` needs a product without it (for example
 * TC_B_28_CS needs a station that cannot reset a single EVSE), and
 * `{ anyOf }` needs at least one of the items supported.
 */
export type PicsPrerequisite = { item: string; requires: boolean } | { anyOf: string[] };

export interface Pics {
  /** Device Under Test the PICS describes: the CSMS or the charging station simulator. */
  sut: SutType;
  version: OcppVersion;
  items: Record<string, PicsItem>;
  /** Test case id -> conditions that must all hold for the test to apply. */
  testPrerequisites: Record<string, PicsPrerequisite[]>;
}

export interface NotApplicable {
  /** PICS item (or items, joined with " | ") that excludes the test. */
  item: string;
  /** Human-readable explanation that cites the PICS item. */
  reason: string;
}
