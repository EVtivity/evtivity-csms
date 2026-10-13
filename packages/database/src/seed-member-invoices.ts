// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type postgres from 'postgres';
import argon2 from 'argon2';
import {
  DAY_MS,
  HOUR_MS,
  MONTH_EDGE_MS,
  insertDemoAccountSession,
  insertDemoInvoice,
  insertDemoLineItems,
  loadDemoStationPlace,
  monthBounds,
  pad,
} from './seed-fleet-billing.js';
import type { DemoLineSession } from './seed-fleet-billing.js';

// Demo data of member invoices (features/fleet-billing.md, Member invoices):
// one fleet on account billing whose invoices go to each member driver
// (account_invoice_recipient = 'member'). Two members: Lena Fischer (German,
// with a billing address) and Sam Carter (English, no billing address). Last
// month Lena got her member invoice; Sam's member invoice of last month was
// credited in full by a credit note, which released his sessions, so they are
// unbilled again beside this month's sessions of both drivers and show in the
// member preview. Fixed ids and ON CONFLICT DO NOTHING on every insert, so a
// rerun changes nothing (P7). Numbers come from the gap-free counter only for
// an invoice id that does not exist yet (insertDemoInvoice).

/** The fixed ids of the member invoice demo (screenshots and tests look them up). */
export const MEMBER_INVOICE_DEMO = {
  fleetId: 'flt_demomemb0001',
  /** German member with a billing address. */
  addressDriverId: 'drv_demomemb0001',
  addressDriverEmail: 'lena.fischer@contoso.example',
  /** English member without a billing address (the CSMS flags it, the portal asks). */
  noAddressDriverId: 'drv_demomemb0002',
  noAddressDriverEmail: 'sam.carter@contoso.example',
  /** Issued member invoice of last month (Lena). */
  invoiceId: 'inv_demomemb0001',
  /** Member invoice of last month (Sam), credited in full. */
  creditedInvoiceId: 'inv_demomemb0002',
  /** Credit note of creditedInvoiceId. */
  creditNoteId: 'inv_demomemb0003',
} as const;

const FLEET_NAME = 'Contoso Engineering';
const TAX_RATE = 0.19;
const CREDIT_LIMIT_CENTS = 30_000;
const PAYMENT_TERMS_DAYS = 14;
/** Sign-in password of the demo members, the demo driver password of seed.ts. */
const MEMBER_PASSWORD = 'driver123';

const FLEET_BILL_TO = {
  name: 'Contoso Engineering GmbH',
  street: 'Friedrichstraße 120',
  city: 'Berlin',
  state: null,
  zip: '10117',
  country: 'Germany',
  taxId: 'DE123456789',
};

const MEMBERS = [
  {
    id: MEMBER_INVOICE_DEMO.addressDriverId,
    firstName: 'Lena',
    lastName: 'Fischer',
    email: MEMBER_INVOICE_DEMO.addressDriverEmail,
    language: 'de',
    address: {
      billingName: 'Lena Fischer',
      billingStreet: 'Kastanienallee 12',
      billingCity: 'Berlin',
      billingZip: '10435',
      billingCountry: 'Germany',
    },
  },
  {
    id: MEMBER_INVOICE_DEMO.noAddressDriverId,
    firstName: 'Sam',
    lastName: 'Carter',
    email: MEMBER_INVOICE_DEMO.noAddressDriverEmail,
    language: 'en',
    address: null,
  },
] as const;

type MemberIndex = 0 | 1;

export interface MemberInvoiceDemoInput {
  /** charging_stations.id of a demo station the sessions ran on. */
  stationId: string;
  evseId: string | null;
  currency: string;
  now: Date;
}

export interface MemberDemoSession {
  id: string;
  transactionId: string;
  driverIndex: MemberIndex;
  startedAt: Date;
  endedAt: Date;
  energyWh: number;
  costCents: number;
  invoiceId: string | null;
  /** The credited member invoice that billed it first (its line items). */
  creditedInvoiceId: string | null;
}

/** The bill-to snapshot of a member invoice, as billToFromDriver writes it. */
function memberBillTo(index: MemberIndex): Record<string, string | null> {
  const member = MEMBERS[index];
  const address = member.address;
  return {
    name: address?.billingName ?? `${member.firstName} ${member.lastName}`,
    street: address?.billingStreet ?? null,
    city: address?.billingCity ?? null,
    state: null,
    zip: address?.billingZip ?? null,
    country: address?.billingCountry ?? null,
    taxId: null,
    email: member.email,
  };
}

/**
 * The demo sessions, all member-billed: last month (Lena's invoiced, Sam's
 * credited and unbilled again) and this month (unbilled, both drivers).
 */
export function memberInvoiceDemoSessions(now: Date): MemberDemoSession[] {
  const sessions: MemberDemoSession[] = [];
  let n = 0;
  const add = (
    driverIndex: MemberIndex,
    startedAt: Date,
    energyWh: number,
    costCents: number,
    invoiceId: string | null,
    creditedInvoiceId: string | null,
  ): void => {
    n += 1;
    sessions.push({
      id: `ses_demomemb${pad(n)}`,
      transactionId: `txn_memb_${pad(n)}`,
      driverIndex,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 90 * 60_000),
      energyWh,
      costCents,
      invoiceId,
      creditedInvoiceId,
    });
  };
  // This month: unbilled. The first session starts 14 hours into the UTC month,
  // so it is in this month in every timezone (fleet-billing demo, same rule).
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) + MONTH_EDGE_MS;
  const span = Math.max(now.getTime() - 3 * HOUR_MS - monthStart, HOUR_MS);
  for (const [i, driver] of ([0, 1] as const).entries()) {
    add(
      driver,
      new Date(monthStart + Math.floor((span * i) / 2)),
      21_000 + i * 6_000,
      2_390 + i * 640,
      null,
      null,
    );
  }
  // Last month: Lena's sessions on her issued invoice, Sam's on his credited one.
  const lastMonth = monthBounds(now, 1).startsAt.getTime();
  for (const [i, driver] of ([0, 0, 1, 1] as const).entries()) {
    const credited = driver === 1;
    add(
      driver,
      new Date(lastMonth + (4 + i * 6) * DAY_MS + 8 * HOUR_MS),
      19_000 + i * 2_500,
      2_150 + i * 310,
      credited ? null : MEMBER_INVOICE_DEMO.invoiceId,
      credited ? MEMBER_INVOICE_DEMO.creditedInvoiceId : null,
    );
  }
  return sessions;
}

/** Seeds the member invoice demo. Returns the number of sessions it inserted. */
export async function seedMemberInvoiceDemo(
  sql: postgres.Sql,
  input: MemberInvoiceDemoInput,
): Promise<number> {
  const { now, currency } = input;
  const demo = MEMBER_INVOICE_DEMO;

  await sql`
    INSERT INTO fleets (id, name, description, account_billing_enabled, account_invoice_recipient,
      billing_contact_emails, billing_legal_name, billing_street, billing_city, billing_state,
      billing_zip, billing_country, billing_tax_id, invoice_language, payment_terms_days,
      auto_invoice, credit_limit_cents, credit_limit_warning_percent)
    VALUES (${demo.fleetId}, ${FLEET_NAME}, ${'Employee charging, invoiced to each driver'}, true,
      'member', ${['fleet-billing@contoso.example']}, ${FLEET_BILL_TO.name},
      ${FLEET_BILL_TO.street}, ${FLEET_BILL_TO.city}, ${FLEET_BILL_TO.state},
      ${FLEET_BILL_TO.zip}, ${FLEET_BILL_TO.country}, ${FLEET_BILL_TO.taxId}, 'de',
      ${PAYMENT_TERMS_DAYS}, false, ${CREDIT_LIMIT_CENTS}, 80)
    ON CONFLICT (id) DO NOTHING
  `;

  const memberPasswordHash = await argon2.hash(MEMBER_PASSWORD);
  for (const [i, member] of MEMBERS.entries()) {
    const address = member.address;
    await sql`
      INSERT INTO drivers (id, first_name, last_name, email, language, registration_source,
        is_active, email_verified, billing_name, billing_street, billing_city, billing_state,
        billing_zip, billing_country, created_at)
      VALUES (${member.id}, ${member.firstName}, ${member.lastName}, ${member.email},
        ${member.language}, 'admin', true, true, ${address?.billingName ?? null},
        ${address?.billingStreet ?? null}, ${address?.billingCity ?? null},
        ${null}, ${address?.billingZip ?? null},
        ${address?.billingCountry ?? null}, ${new Date(now.getTime() - (90 - i) * DAY_MS)})
      ON CONFLICT (id) DO NOTHING
    `;
    // Sign-in for the portal and the app. Only where no password is set, so a
    // rerun or a password the driver chose stays untouched.
    await sql`
      UPDATE drivers SET password_hash = ${memberPasswordHash}
      WHERE id = ${member.id} AND password_hash IS NULL
    `;
    await sql`
      INSERT INTO fleet_drivers (fleet_id, driver_id, account_billing_opt_out, created_at)
      VALUES (${demo.fleetId}, ${member.id}, false,
        ${new Date(now.getTime() - (80 - i) * DAY_MS)})
      ON CONFLICT (fleet_id, driver_id) DO NOTHING
    `;
  }

  const place = await loadDemoStationPlace(sql, input.stationId);
  const sessions = memberInvoiceDemoSessions(now);
  const lastMonth = monthBounds(now, 1);
  const issuedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9));
  const creditNoteIssuedAt = new Date(issuedAt.getTime() + 2 * HOUR_MS);
  const lineSessions = (list: MemberDemoSession[]): DemoLineSession[] =>
    [...list]
      .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime())
      .map((session) => {
        const member = MEMBERS[session.driverIndex];
        return {
          id: session.id,
          endedAt: session.endedAt,
          energyWh: session.energyWh,
          costCents: session.costCents,
          driverId: member.id,
          driverName: `${member.firstName} ${member.lastName}`,
        };
      });
  const invoiced = sessions.filter((s) => s.invoiceId === demo.invoiceId);
  const credited = sessions.filter((s) => s.creditedInvoiceId === demo.creditedInvoiceId);
  const header = (index: MemberIndex) => ({
    fleetId: demo.fleetId,
    driverId: MEMBERS[index].id,
    memberBilled: true,
    billTo: memberBillTo(index),
    language: MEMBERS[index].language,
    currency,
    paymentTermsDays: PAYMENT_TERMS_DAYS,
    taxRate: TAX_RATE,
    period: lastMonth,
  });

  // Invoices first: the sessions reference them.
  await insertDemoInvoice(sql, demo.invoiceId, {
    ...header(0),
    kind: 'invoice',
    status: 'issued',
    issuedAt,
    sessions: lineSessions(invoiced),
    sign: 1,
    creditedInvoiceId: null,
    creditReason: null,
  });
  await insertDemoInvoice(sql, demo.creditedInvoiceId, {
    ...header(1),
    kind: 'invoice',
    status: 'credited',
    issuedAt,
    sessions: lineSessions(credited),
    sign: 1,
    creditedInvoiceId: null,
    creditReason: null,
  });
  await insertDemoInvoice(sql, demo.creditNoteId, {
    ...header(1),
    kind: 'credit_note',
    status: 'issued',
    issuedAt: creditNoteIssuedAt,
    sessions: lineSessions(credited),
    sign: -1,
    creditedInvoiceId: demo.creditedInvoiceId,
    creditReason: 'Private trips charged on the company account; billed again next month',
  });

  let inserted = 0;
  for (const session of sessions) {
    inserted += await insertDemoAccountSession(sql, {
      ...session,
      stationId: input.stationId,
      evseId: input.evseId,
      driverId: MEMBERS[session.driverIndex].id,
      fleetId: demo.fleetId,
      memberBilled: true,
      taxRate: TAX_RATE,
      currency,
      electricityCostCents: place.electricityCostOf(session.endedAt, session.energyWh),
    });
  }

  for (const [invoiceId, list, sign] of [
    [demo.invoiceId, invoiced, 1],
    [demo.creditedInvoiceId, credited, 1],
    [demo.creditNoteId, credited, -1],
  ] as const) {
    await insertDemoLineItems(sql, invoiceId, lineSessions(list), sign, {
      stationName: place.stationName,
      taxRate: TAX_RATE,
    });
  }

  return inserted;
}
