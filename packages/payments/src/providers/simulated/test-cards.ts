// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * What a simulated method or payment does. Encoded in its ids, so the outcome
 * is the same in the API, OCPP and worker processes without shared state.
 */
export type SimulatedScenario =
  | 'approve'
  | 'decline'
  | 'nofunds'
  | 'chargefail'
  | 'action'
  | 'partial'
  | 'capfail'
  | 'adjfail'
  | 'refundfail'
  | 'dispute'
  | 'random';

export const SIMULATED_SCENARIOS: readonly SimulatedScenario[] = [
  'approve',
  'decline',
  'nofunds',
  'chargefail',
  'action',
  'partial',
  'capfail',
  'adjfail',
  'refundfail',
  'dispute',
  'random',
];

export interface SimulatedTestCard {
  number: string;
  label: string;
  brand: 'visa' | 'mastercard';
  scenario: SimulatedScenario;
}

/** The only card numbers the simulated provider accepts (all Luhn-valid). */
export const SIMULATED_TEST_CARDS: readonly SimulatedTestCard[] = [
  { number: '4242424242424242', label: 'Approve (Visa)', brand: 'visa', scenario: 'approve' },
  { number: '4111111111111111', label: 'Approve (Visa)', brand: 'visa', scenario: 'approve' },
  {
    number: '5555555555554444',
    label: 'Approve (Mastercard)',
    brand: 'mastercard',
    scenario: 'approve',
  },
  {
    number: '4000000000000002',
    label: 'Decline: card declined',
    brand: 'visa',
    scenario: 'decline',
  },
  {
    number: '4000000000009995',
    label: 'Decline: insufficient funds',
    brand: 'visa',
    scenario: 'nofunds',
  },
  {
    number: '4000000000000341',
    label: 'Saves, every charge declines',
    brand: 'visa',
    scenario: 'chargefail',
  },
  {
    number: '4000002500003155',
    label: 'Requires authentication',
    brand: 'visa',
    scenario: 'action',
  },
  {
    number: '4917610000000000',
    label: 'Requires authentication (3DS2)',
    brand: 'visa',
    scenario: 'action',
  },
  {
    number: '4000000000000606',
    label: 'Partial approval (50%)',
    brand: 'visa',
    scenario: 'partial',
  },
  { number: '4000000000000408', label: 'Capture fails', brand: 'visa', scenario: 'capfail' },
  {
    number: '4000000000000309',
    label: 'Hold adjustment declined',
    brand: 'visa',
    scenario: 'adjfail',
  },
  { number: '4000000000000507', label: 'Refund fails', brand: 'visa', scenario: 'refundfail' },
  {
    number: '4000000000000259',
    label: 'Disputed after capture',
    brand: 'visa',
    scenario: 'dispute',
  },
];

/** The test card with this number, or null. Never log the number of a miss. */
export function findTestCard(number: unknown): SimulatedTestCard | null {
  if (typeof number !== 'string') return null;
  return SIMULATED_TEST_CARDS.find((c) => c.number === number) ?? null;
}
