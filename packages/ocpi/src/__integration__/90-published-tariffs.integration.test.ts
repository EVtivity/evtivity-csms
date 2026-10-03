// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The OCPI server side of published tariffs and CPO sessions against a real
// database: tariffs generated from internal pricing per partner, the mapping
// that covers a session tariff, and our sessions as CPO rendered from the
// charging session. The API side (mapping routes, credit CDRs) is in
// packages/api/src/__integration__/65-ocpi-tariff-mappings-credit.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { generateId } from '@evtivity/lib';
import { clearSystemSettingsCache } from '@evtivity/database';
import * as published from '../services/published-tariffs.js';
import * as cpoSessions from '../services/cpo-sessions.js';

const sql = postgres(
  process.env['DATABASE_URL'] ?? 'postgres://evtivity:evtivity@localhost:5433/evtivity_test',
  { max: 2, onnotice: () => {} },
);

type Row = Record<string, unknown>;

afterAll(async () => {
  await sql.end();
});

beforeEach(async () => {
  await sql`
    TRUNCATE TABLE ocpi_partners, ocpi_tariff_mappings, tariffs, pricing_groups,
      charging_sessions, charging_stations, sites CASCADE
  `;
  await sql`
    INSERT INTO settings (key, value) VALUES ('company.currency', ${sql.json('EUR')})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
  clearSystemSettingsCache();
});

async function createPartner(partyId: string, version = '2.2.1'): Promise<string> {
  const id = generateId('ocpiPartner');
  await sql`
    INSERT INTO ocpi_partners (id, name, country_code, party_id, status, version)
    VALUES (${id}, ${`Partner ${partyId}`}, 'NL', ${partyId}, 'connected', ${version})
  `;
  return id;
}

async function createSite(): Promise<Row> {
  const [row] = await sql`
    INSERT INTO sites (id, name, address, city, state, postal_code, country)
    VALUES (${generateId('site')}, 'Site', '1 Main St', 'Berlin', 'BE', '10115', 'DEU')
    RETURNING *
  `;
  return row as Row;
}

async function createStation(siteId: string): Promise<Row> {
  const [row] = await sql`
    INSERT INTO charging_stations (id, station_id, site_id, model, onboarding_status)
    VALUES (${generateId('station')}, ${`CS-${String(Date.now())}`}, ${siteId}, 'M', 'accepted')
    RETURNING *
  `;
  return row as Row;
}

async function createSession(stationId: string, transactionId: string, status: string) {
  const [row] = await sql`
    INSERT INTO charging_sessions (id, station_id, transaction_id, status, started_at, currency)
    VALUES (${generateId('session')}, ${stationId}, ${transactionId}, ${status}, NOW(), 'EUR')
    RETURNING *
  `;
  return row as Row;
}

async function createTariff(groupId: string, name: string, pricePerKwh: string): Promise<string> {
  const id = generateId('tariff');
  await sql`
    INSERT INTO tariffs (id, pricing_group_id, name, price_per_kwh)
    VALUES (${id}, ${groupId}, ${name}, ${pricePerKwh})
  `;
  return id;
}

/** A pricing group with a default tariff and an off-peak tariff (22:00-06:00, weekends). */
async function createGroupWithOffPeak(): Promise<{
  groupId: string;
  defaultId: string;
  offPeakId: string;
}> {
  const groupId = generateId('pricingGroup');
  await sql`INSERT INTO pricing_groups (id, name) VALUES (${groupId}, 'Group')`;
  const defaultId = await createTariff(groupId, 'Standard', '0.30');
  const offPeakId = await createTariff(groupId, 'Off-peak', '0.20');
  await sql`
    UPDATE tariffs SET is_default = true, priority = 0, tax_rate = '0.19',
      price_per_minute = '0.05', idle_fee_price_per_minute = '0.10'
    WHERE id = ${defaultId}
  `;
  await sql`
    UPDATE tariffs SET priority = 20, tax_rate = '0.19',
      restrictions = ${sql.json({ timeRange: { startTime: '22:00', endTime: '06:00' }, daysOfWeek: [0, 6] })}
    WHERE id = ${offPeakId}
  `;
  return { groupId, defaultId, offPeakId };
}

async function createMapping(values: {
  ocpiTariffId: string;
  tariffId?: string;
  pricingGroupId?: string;
  partnerId?: string;
}): Promise<void> {
  await sql`
    INSERT INTO ocpi_tariff_mappings (ocpi_tariff_id, tariff_id, pricing_group_id, partner_id)
    VALUES (${values.ocpiTariffId}, ${values.tariffId ?? null}, ${values.pricingGroupId ?? null},
      ${values.partnerId ?? null})
  `;
}

describe('published tariffs', () => {
  it('renders a pricing group with restrictions, VAT percent, per-hour time, and the company currency', async () => {
    const { groupId } = await createGroupWithOffPeak();
    const partnerId = await createPartner('AAA');
    await createMapping({ ocpiTariffId: 'G-1', pricingGroupId: groupId });

    const [tariff] = await published.renderPartnerTariffs(partnerId, '2.3.0');
    expect(tariff).toMatchObject({ id: 'G-1', currency: 'EUR', tax_included: 'NO' });
    expect(tariff?.elements).toEqual([
      {
        price_components: [
          { type: 'ENERGY', price: 0.2, step_size: 1, vat: 19 },
          { type: 'TIME', price: 0, step_size: 1, vat: 19 },
          { type: 'PARKING_TIME', price: 0, step_size: 1, vat: 19 },
        ],
        restrictions: {
          start_time: '22:00',
          end_time: '06:00',
          day_of_week: ['SUNDAY', 'SATURDAY'],
        },
      },
      {
        price_components: [
          { type: 'ENERGY', price: 0.3, step_size: 1, vat: 19 },
          { type: 'TIME', price: 3, step_size: 1, vat: 19 },
          { type: 'PARKING_TIME', price: 9, step_size: 1, vat: 19 },
        ],
      },
    ]);
  });

  it('serves a partner its own mapping in place of the global one with the same id', async () => {
    const { groupId, defaultId } = await createGroupWithOffPeak();
    const partnerA = await createPartner('AAA');
    const partnerB = await createPartner('BBB');
    await createMapping({ ocpiTariffId: 'G-1', pricingGroupId: groupId });
    await createMapping({ ocpiTariffId: 'G-1', tariffId: defaultId, partnerId: partnerA });

    const forA = await published.renderPartnerTariffs(partnerA, '2.2.1');
    const forB = await published.renderPartnerTariffs(partnerB, '2.2.1');
    expect(forA).toHaveLength(1);
    expect(forA[0]?.elements).toHaveLength(1);
    expect(forB).toHaveLength(1);
    expect(forB[0]?.elements).toHaveLength(2);
    expect(forA[0]).not.toHaveProperty('tax_included');
  });

  it('finds the mapping that covers a session tariff through its pricing group', async () => {
    const { groupId, offPeakId } = await createGroupWithOffPeak();
    const partnerId = await createPartner('AAA');
    await createMapping({ ocpiTariffId: 'G-1', pricingGroupId: groupId });
    const mapping = await published.sessionTariffMapping(partnerId, offPeakId);
    expect(mapping).toMatchObject({ ocpiTariffId: 'G-1', pricingGroupId: groupId });
  });
});

describe('CPO sessions', () => {
  it('serves only our sessions started with the partner token, rendered from the charging session', async () => {
    const partnerId = await createPartner('AAA', '2.2.1');
    const site = await createSite();
    const station = await createStation(site.id as string);
    const session = await createSession(station.id as string, 'TX-CPO-1', 'completed');
    await sql`
      UPDATE charging_sessions
      SET ended_at = started_at + interval '1 hour', final_cost_cents = 476,
          tariff_tax_rate = '0.19', energy_delivered_wh = '10000', currency = 'EUR'
      WHERE id = ${session.id as string}
    `;
    await sql`
      INSERT INTO ocpi_external_tokens (partner_id, country_code, party_id, uid, token_type, token_data)
      VALUES (${partnerId}, 'NL', 'AAA', 'TOKEN-1', 'APP_USER', ${sql.json({ contract_id: 'NL-AAA-C1' })})
    `;
    await sql`
      INSERT INTO ocpi_roaming_sessions (partner_id, ocpi_session_id, charging_session_id, token_uid, status)
      VALUES (${partnerId}, 'TX-CPO-1', ${session.id as string}, 'TOKEN-1', 'ACTIVE'),
             (${partnerId}, 'PARTNER-OWN-1', NULL, 'OUR-TOKEN', 'ACTIVE')
    `;

    const { total, sessions } = await cpoSessions.listPartnerCpoSessions(partnerId, '2.2.1', {
      offset: 0,
      limit: 10,
    });
    expect(total).toBe(1);
    expect(sessions[0]).toMatchObject({
      id: 'TX-CPO-1',
      status: 'COMPLETED',
      kwh: 10,
      currency: 'EUR',
      location_id: site.id,
      total_cost: { excl_vat: 4, incl_vat: 4.76 },
      cdr_token: { uid: 'TOKEN-1', type: 'APP_USER', contract_id: 'NL-AAA-C1' },
    });

    const link = await cpoSessions.cpoSessionLink(session.id as string);
    expect(link).toMatchObject({ partnerId, tokenUid: 'TOKEN-1' });
    await cpoSessions.syncCpoSessionRow(link!, sessions[0]!, '2.2.1');
    const [row] = await sql`
      SELECT status, total_cost, kwh FROM ocpi_roaming_sessions WHERE ocpi_session_id = 'TX-CPO-1'
    `;
    expect(row).toMatchObject({ status: 'COMPLETED', total_cost: '4.00', kwh: '10.0000' });
  });
});
