// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import eventSettings from '../EventSettingsLayout.tsx?raw';
import electricityRates from '../SiteElectricityRatesTab.tsx?raw';
import maintenance from '../SiteMaintenanceTab.tsx?raw';
import certificates from '../StationCertificates.tsx?raw';
import chargingProfiles from '../StationChargingProfilesTab.tsx?raw';
import configurations from '../StationConfigurationsTab.tsx?raw';
import displayMessages from '../StationDisplayMessages.tsx?raw';
import simulate from '../StationSimulate.tsx?raw';
import popularTimes from '../charts/PopularTimesChart.tsx?raw';
import generateReport from '../reports/GenerateTab.tsx?raw';
import reportSchedules from '../reports/SchedulesTab.tsx?raw';
import fleetInvoices from '../fleet/FleetInvoicesCard.tsx?raw';
import panelTree from '../load-management/PanelTree.tsx?raw';
import sessionDetails from '../session/SessionDetailsTab.tsx?raw';
import smartChargingTemplate from '../../pages/SmartChargingTemplateDetail.tsx?raw';
import supportCase from '../../pages/SupportCaseDetail.tsx?raw';
import aiInsight from '../../pages/AiInsightDetail.tsx?raw';

describe('Phone-width layouts', () => {
  it('stacks the site Electricity Rates and Maintenance headers over their actions until sm', () => {
    // TabPanel stacks its header over its actions until sm.
    expect(electricityRates).toContain('<TabPanel');
    expect(electricityRates).toContain(
      '<div className="flex flex-wrap items-center gap-2 sm:justify-end">',
    );
    expect(maintenance).toContain('<TabPanel');
  });

  it('wraps the station tab header actions so a long label keeps its own width', () => {
    for (const source of [certificates, chargingProfiles, displayMessages]) {
      expect(source).toContain('className="flex flex-wrap gap-2 *:grow sm:*:grow-0"');
    }
    for (const source of [certificates, chargingProfiles, configurations, displayMessages]) {
      // Two fixed columns cut "Refresh from Station" and "View Composite Schedule" off.
      expect(source).not.toContain('grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]');
    }
  });

  it('keeps the Configurations search and its three buttons on one row from sm', () => {
    expect(configurations).toContain('actionsPosition="fill"');
    // The search grows and shrinks (at least 10rem) instead of a fixed max width.
    expect(configurations).toContain('className="w-full sm:w-auto sm:min-w-40 sm:flex-1"');
    // Icon only between sm and 85rem, the label kept for screen readers; phones keep it.
    expect(configurations).toContain("const COMPACT_LABEL = 'sm:max-[85rem]:sr-only';");
    expect(configurations.match(/<span className=\{COMPACT_LABEL\}>/g)).toHaveLength(3);
    // Each control takes the row on phones (the Edit link too, drawn as a button).
    expect(configurations.match(/'grow sm:grow-0'|"grow sm:grow-0"/g)).toHaveLength(3);
  });

  it('lets a simulator action label take two lines inside its button', () => {
    expect(simulate).toContain('className="relative w-full min-w-0"');
    expect(simulate).toContain('whitespace-normal text-center leading-tight');
  });

  it('fits the seven Popular Times days in one row', () => {
    expect(popularTimes).toContain('<div className="grid grid-cols-7 gap-1 sm:flex">');
    expect(popularTimes).toContain('min-w-0 rounded-md py-1');
    expect(popularTimes).not.toContain('px-2 py-1 text-xs');
  });

  it('lets the report date range inputs share the row', () => {
    for (const source of [generateReport, reportSchedules]) {
      expect(
        source.match(
          /type="date"\n\s+aria-label=\{t\('common\.(start|end)Date'\)\}\n\s+className="min-w-0 flex-1"/g,
        ),
      ).toHaveLength(2);
    }
  });

  it('keeps the event settings columns within the page', () => {
    expect(eventSettings).toContain('className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]"');
    expect(eventSettings.match(/<div className="min-w-0 space-y-4">/g)).toHaveLength(2);
  });

  it('wraps the load management panel and circuit rows and their actions', () => {
    expect(panelTree).toContain(
      '<Badge variant="warning" className="max-w-full whitespace-normal text-xs">',
    );
    expect(panelTree).toContain('<div className="flex flex-wrap gap-2 pl-4">');
    expect(panelTree).toMatch(
      /<div className="flex flex-wrap items-center gap-2">\s+<p className="text-sm font-medium">\{circuit\.name\}<\/p>/,
    );
  });

  it('lets a value and its note break onto the next line in detail rows', () => {
    for (const source of [sessionDetails, supportCase]) {
      expect(source).toContain('<div className="min-w-0 flex-1 wrap-anywhere">{children}</div>');
    }
    // A space between the token and its type, and between the PCID and its status badge:
    // without one the browser cannot break the line there.
    expect(sessionDetails).toContain("</Link>{' '}");
    expect(sessionDetails).toMatch(/<\/span>\{' '\}\s+<Badge/);
    expect(supportCase).not.toContain(
      '<span className="ml-2 text-muted-foreground">({caseDetail.driverEmail})</span>',
    );
  });

  it('wraps the fleet invoice period and Generate Invoice', () => {
    expect(fleetInvoices).toContain('<div className="flex flex-wrap items-end gap-2">');
  });

  it('stacks the insight detail labels over their values until sm', () => {
    expect(aiInsight).toContain('grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]');
  });

  it('wraps the smart charging template actions', () => {
    expect(smartChargingTemplate).toContain('className="flex flex-wrap gap-2 *:grow sm:*:grow-0"');
  });
});
