// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;

const nanoid = customAlphabet(ALPHABET, ID_LENGTH);

export const ID_PREFIXES = {
  role: 'rol',
  user: 'usr',
  site: 'sit',
  vendor: 'vnd',
  station: 'sta',
  evse: 'evs',
  connector: 'con',
  session: 'ses',
  driver: 'drv',
  driverToken: 'dtk',
  vehicle: 'veh',
  fleet: 'flt',
  tariff: 'trf',
  pricingGroup: 'pgr',
  reservation: 'rsv',
  supportCase: 'cas',
  invoice: 'inv',
  ocpiPartner: 'opr',
  report: 'rpt',
  firmwareCampaign: 'fwc',
  configTemplate: 'ctm',
  configTemplatePush: 'ctp',
} as const;

export type EntityType = keyof typeof ID_PREFIXES;

export function generateId(entity: EntityType): string {
  return `${ID_PREFIXES[entity]}_${nanoid()}`;
}
