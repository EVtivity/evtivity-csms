// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The shipped depot departure notices show the departure time in the
// recipient's time zone, in the email and the SMS, as the dispatcher formats it.

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDateVariables, renderTemplate } from '@evtivity/lib';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url));

const VARIABLES = {
  companyName: 'EVtivity',
  firstName: 'Ana',
  vehicleName: 'Volvo 7900',
  licensePlate: 'BUS-12',
  siteName: 'North Depot',
  // 05:30 in New York on Nov 2 2026 (EST, UTC-5); 11:30 in Berlin.
  departureAt: '2026-11-02T10:30:00.000Z',
  cannotMeet: false,
  shortfallKwh: '32.4',
  reasonSiteCapacity: true,
  noVehicle: true,
  deliveredKwh: '0.0',
  targetKwh: '80.0',
  targetSocPercent: '',
  readinessUrl: 'https://csms.example.com/sites/sit_1?tab=fleet-readiness',
};

async function render(
  event: string,
  channel: 'email' | 'sms',
  timezone: string,
  language: string,
): Promise<string> {
  const vars = formatDateVariables(VARIABLES, timezone, language);
  const rendered = await renderTemplate(
    channel,
    event,
    language,
    vars,
    undefined,
    undefined,
    TEMPLATES_DIR,
  );
  return rendered.html ?? rendered.body;
}

describe('departure notice templates', () => {
  it.each(['fleet.DepartureAtRisk', 'fleet.DepartureMissed'])(
    '%s shows the departure in the recipient time zone in email and SMS',
    async (event) => {
      for (const channel of ['email', 'sms'] as const) {
        const ny = await render(event, channel, 'America/New_York', 'en');
        expect(ny, channel).toMatch(/Nov 2, 2026, 5:30\sAM/);
        expect(ny, channel).not.toContain('2026-11-02T10:30');
        const berlin = await render(event, channel, 'Europe/Berlin', 'de');
        expect(berlin, channel).toContain('02.11.2026, 11:30');
      }
    },
  );

  it('links the email to the readiness tab and words the reason', async () => {
    const html = await render('fleet.DepartureAtRisk', 'email', 'UTC', 'en');
    // Email bodies HTML-escape variables, so the "=" of the query arrives as &#x3D;.
    expect(html).toMatch(
      /href='https:\/\/csms\.example\.com\/sites\/sit_1\?tab(=|&#x3D;)fleet-readiness'/,
    );
    expect(html).toContain('The site does not have enough power for every vehicle.');
    expect(html).toContain('32.4 kWh short');
  });
});
