// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  OCPP_PROTOCOLS,
  OCPP21_ONLY_ACTIONS,
  OCPP201_NETWORK_INTERFACES,
  isOcpp2x,
  isOcpp21,
  isOcpp21OnlyAction,
  isOcpp21OnlyMessage,
  OCPP21_ONLY_SEND_MESSAGES,
  ocpp2xActionFitsProtocol,
  stationMessageContentFor,
} from '../ocpp-version.js';
import * as lib from '../index.js';

describe('isOcpp21OnlyAction and ocpp2xActionFitsProtocol', () => {
  it('names the 26 messages only OCPP 2.1 defines', () => {
    expect(OCPP21_ONLY_ACTIONS).toHaveLength(26);
    expect(isOcpp21OnlyAction('SetDefaultTariff')).toBe(true);
    expect(isOcpp21OnlyAction('SetVariables')).toBe(false);
    expect(isOcpp21OnlyAction('constructor')).toBe(false);
  });

  it('offers a shared action to 2.0.1 and 2.1 stations and a 2.1-only one to 2.1 only', () => {
    expect(ocpp2xActionFitsProtocol('SetChargingProfile', 'ocpp2.0.1')).toBe(true);
    expect(ocpp2xActionFitsProtocol('SetChargingProfile', 'ocpp2.1')).toBe(true);
    expect(ocpp2xActionFitsProtocol('SetChargingProfile', 'ocpp1.6')).toBe(false);
    expect(ocpp2xActionFitsProtocol('GetTariffs', 'ocpp2.0.1')).toBe(false);
    expect(ocpp2xActionFitsProtocol('GetTariffs', 'ocpp2.1')).toBe(true);
    expect(lib.ocpp2xActionFitsProtocol).toBe(ocpp2xActionFitsProtocol);
  });
});

describe('OCPP_PROTOCOLS', () => {
  it('lists the three protocols the CSMS speaks', () => {
    expect(OCPP_PROTOCOLS).toEqual(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']);
  });

  it('is exported from the package root', () => {
    expect(lib.OCPP_PROTOCOLS).toBe(OCPP_PROTOCOLS);
    expect(lib.isOcpp2x).toBe(isOcpp2x);
    expect(lib.isOcpp21).toBe(isOcpp21);
  });
});

describe('isOcpp2x', () => {
  it.each([
    ['ocpp2.1', true],
    ['ocpp2.0.1', true],
    ['ocpp1.6', false],
    ['ocpp2.0', false],
    ['', false],
  ])('%s -> %s', (protocol, expected) => {
    expect(isOcpp2x(protocol)).toBe(expected);
  });

  it('is false for null and undefined', () => {
    expect(isOcpp2x(null)).toBe(false);
    expect(isOcpp2x(undefined)).toBe(false);
  });
});

describe('isOcpp21', () => {
  it.each([
    ['ocpp2.1', true],
    ['ocpp2.0.1', false],
    ['ocpp1.6', false],
    ['', false],
  ])('%s -> %s', (protocol, expected) => {
    expect(isOcpp21(protocol)).toBe(expected);
  });

  it('is false for null and undefined', () => {
    expect(isOcpp21(null)).toBe(false);
    expect(isOcpp21(undefined)).toBe(false);
  });
});

describe('stationMessageContentFor', () => {
  it('cuts OCPP 2.0.1 content to 512 characters', () => {
    expect(stationMessageContentFor('ocpp2.0.1', 'a'.repeat(600))).toBe('a'.repeat(512));
    expect(stationMessageContentFor('ocpp2.0.1', 'short')).toBe('short');
  });

  it('counts code points, so a surrogate pair is never split', () => {
    const cut = stationMessageContentFor('ocpp2.0.1', '\u{1F50C}'.repeat(600));
    expect(Array.from(cut)).toHaveLength(512);
    expect(cut).toBe('\u{1F50C}'.repeat(512));
    // 300 emoji are 600 UTF-16 units but 300 characters: kept whole.
    expect(stationMessageContentFor('ocpp2.0.1', '\u{1F50C}'.repeat(300))).toBe(
      '\u{1F50C}'.repeat(300),
    );
  });

  it.each(['ocpp2.1', 'ocpp1.6', null])('keeps the content of a %s station', (protocol) => {
    expect(stationMessageContentFor(protocol, 'a'.repeat(600))).toHaveLength(600);
  });
});

describe('isOcpp21OnlyMessage', () => {
  it('covers the 2.1-only CALL actions and the SEND message NotifyPeriodicEventStream', () => {
    expect(OCPP21_ONLY_SEND_MESSAGES).toEqual(['NotifyPeriodicEventStream']);
    expect(isOcpp21OnlyMessage('NotifyPeriodicEventStream')).toBe(true);
    expect(isOcpp21OnlyAction('NotifyPeriodicEventStream')).toBe(false);
    for (const action of OCPP21_ONLY_ACTIONS) expect(isOcpp21OnlyMessage(action)).toBe(true);
    expect(isOcpp21OnlyMessage('Heartbeat')).toBe(false);
  });
});

describe('OCPP201_NETWORK_INTERFACES', () => {
  it('lists the OCPP 2.0.1 OCPPInterfaceEnumType values, without the 2.1-only Any', () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          '../../../../schemas/ocpp-2.0.1/SetNetworkProfileRequest.json',
        ),
        'utf8',
      ),
    ) as { definitions: { OCPPInterfaceEnumType: { enum: string[] } } };
    expect([...OCPP201_NETWORK_INTERFACES]).toEqual(schema.definitions.OCPPInterfaceEnumType.enum);
    expect(lib.OCPP201_NETWORK_INTERFACES).toBe(OCPP201_NETWORK_INTERFACES);
  });
});
