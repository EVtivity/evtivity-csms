// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TFunction } from 'i18next';
import type { ClientConfig } from '../types';

/** One entry of the simulated provider's `testCards` (client config and setup session). */
export interface TestCard {
  number: string;
  scenario: string;
  /** English label from the API, used only when the scenario has no translation. */
  label: string;
}

const SCENARIO_KEYS: Record<string, string> = {
  approve: 'paymentProviders.simulated.scenario.approve',
  decline: 'paymentProviders.simulated.scenario.decline',
  nofunds: 'paymentProviders.simulated.scenario.nofunds',
  chargefail: 'paymentProviders.simulated.scenario.chargefail',
  action: 'paymentProviders.simulated.scenario.action',
  partial: 'paymentProviders.simulated.scenario.partial',
  capfail: 'paymentProviders.simulated.scenario.capfail',
  adjfail: 'paymentProviders.simulated.scenario.adjfail',
  refundfail: 'paymentProviders.simulated.scenario.refundfail',
  dispute: 'paymentProviders.simulated.scenario.dispute',
  random: 'paymentProviders.simulated.scenario.random',
};

const REFUSED_KEYS: Record<string, string> = {
  card_declined: 'paymentProviders.refused.card_declined',
  insufficient_funds: 'paymentProviders.refused.insufficient_funds',
  authentication_failed: 'paymentProviders.refused.authentication_failed',
};

function isTestCard(value: unknown): value is TestCard {
  if (value == null || typeof value !== 'object') return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card['number'] === 'string' &&
    card['number'] !== '' &&
    typeof card['scenario'] === 'string' &&
    typeof card['label'] === 'string'
  );
}

/** The test cards the API lists; malformed entries are skipped. */
export function readTestCards(config: ClientConfig): TestCard[] {
  const cards = config['testCards'];
  return Array.isArray(cards) ? cards.filter(isTestCard) : [];
}

/** Localized scenario label plus the last 4 digits, so two cards of one scenario differ. */
export function testCardLabel(card: TestCard, t: TFunction): string {
  const key = SCENARIO_KEYS[card.scenario];
  const label = key != null ? t(key) : card.label;
  return `${label} (•••• ${card.number.slice(-4)})`;
}

/** Text for a refused card; unknown provider reasons get the generic message. */
export function refusedMessage(reason: string, t: TFunction): string {
  return t(REFUSED_KEYS[reason] ?? 'paymentProviders.refused.default');
}

/** The method id of a simulated `method_setup` challenge, or null for another action. */
export function challengeMethodId(data: unknown): string | null {
  if (data == null || typeof data !== 'object') return null;
  const challenge = data as Record<string, unknown>;
  if (challenge['challenge'] !== 'method_setup') return null;
  const methodId = challenge['methodId'];
  return typeof methodId === 'string' && methodId !== '' ? methodId : null;
}
