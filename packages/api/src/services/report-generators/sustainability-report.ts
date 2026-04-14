// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, gte, lte, eq, count, inArray } from 'drizzle-orm';
import { db, chargingSessions, chargingStations, sites, settings } from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { ReportGeneratorResult } from '../report.service.js';

// EPA defaults
const DEFAULT_GRID_EMISSION_FACTOR = 0.386; // kg CO2/kWh (US average)
const DEFAULT_EV_EFFICIENCY = 3.3; // miles/kWh
const DEFAULT_GASOLINE_EMISSION_FACTOR = 8.887; // kg CO2/gallon
const DEFAULT_AVG_MPG = 25.4; // US average fuel economy

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  return {
    dateFrom: typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined,
    dateTo: typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined,
    siteId: typeof raw['siteId'] === 'string' ? raw['siteId'] : undefined,
  };
}

interface SustainabilitySettings {
  gridEmissionFactor: number;
  evEfficiency: number;
  gasolineEmissionFactor: number;
  avgMpg: number;
}

async function getSustainabilitySettings(): Promise<SustainabilitySettings> {
  const keys = [
    'sustainability.gridEmissionFactor',
    'sustainability.evEfficiency',
    'sustainability.gasolineEmissionFactor',
    'sustainability.avgMpg',
  ];

  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, keys));

  const map = new Map(rows.map((r) => [r.key, r.value]));

  return {
    gridEmissionFactor:
      Number(map.get('sustainability.gridEmissionFactor')) || DEFAULT_GRID_EMISSION_FACTOR,
    evEfficiency: Number(map.get('sustainability.evEfficiency')) || DEFAULT_EV_EFFICIENCY,
    gasolineEmissionFactor:
      Number(map.get('sustainability.gasolineEmissionFactor')) || DEFAULT_GASOLINE_EMISSION_FACTOR,
    avgMpg: Number(map.get('sustainability.avgMpg')) || DEFAULT_AVG_MPG,
  };
}

async function getTimezone(): Promise<string> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'system.timezone'));
  return typeof row?.value === 'string' ? row.value : 'America/New_York';
}

interface EnergyBySite {
  siteName: string;
  energyKwh: number;
  sessionCount: number;
}

interface EnergyByDay {
  date: string;
  energyKwh: number;
}

async function queryEnergyBySite(filters: Filters): Promise<EnergyBySite[]> {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }
  if (filters.siteId) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, 'No Site')`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
      sessionCount: count(),
    })
    .from(chargingSessions)
    .leftJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(sites, eq(chargingStations.siteId, sites.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sites.id, sites.name)
    .orderBy(sql`2 desc`);

  return rows;
}

async function queryEnergyByDay(filters: Filters, tz: string): Promise<EnergyByDay[]> {
  const conditions = [];
  if (filters.dateFrom) {
    conditions.push(gte(chargingSessions.startedAt, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const to = new Date(filters.dateTo);
    to.setHours(23, 59, 59, 999);
    conditions.push(lte(chargingSessions.startedAt, to));
  }

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)`,
    })
    .from(chargingSessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows;
}

function computeSustainability(energyKwh: number, cfg: SustainabilitySettings) {
  // GHG prevented = energy delivered * grid emission factor
  const ghgPreventedKg = energyKwh * cfg.gridEmissionFactor;

  // Miles driven on electricity
  const evMiles = energyKwh * cfg.evEfficiency;

  // Gallons of gasoline displaced
  const gallonsDisplaced = evMiles / cfg.avgMpg;

  // CO2 from displaced gasoline
  const gasolineCo2Kg = gallonsDisplaced * cfg.gasolineEmissionFactor;

  // Net GHG reduction (gasoline CO2 - grid CO2)
  const netGhgReductionKg = gasolineCo2Kg - ghgPreventedKg;

  return {
    ghgPreventedKg: Math.round(ghgPreventedKg * 100) / 100,
    evMiles: Math.round(evMiles * 100) / 100,
    gallonsDisplaced: Math.round(gallonsDisplaced * 100) / 100,
    gasolineCo2Kg: Math.round(gasolineCo2Kg * 100) / 100,
    netGhgReductionKg: Math.round(netGhgReductionKg * 100) / 100,
  };
}

export async function generateSustainabilityReport(
  rawFilters: Record<string, unknown>,
  format: string,
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const [cfg, tz] = await Promise.all([getSustainabilitySettings(), getTimezone()]);

  const [bySite, byDay] = await Promise.all([
    queryEnergyBySite(filters),
    queryEnergyByDay(filters, tz),
  ]);

  const totalKwh = bySite.reduce((sum, r) => sum + parseFloat(String(r.energyKwh)), 0);
  const totals = computeSustainability(totalKwh, cfg);
  const dateLabel = [filters.dateFrom, filters.dateTo].filter(Boolean).join(' to ') || 'All time';

  if (format === 'csv') {
    const headers = ['Metric', 'Value'];
    const rows: unknown[][] = [
      ['Total Energy Delivered (kWh)', totalKwh.toFixed(2)],
      ['Net GHG Reduction (kg CO2)', parseFloat(String(totals.netGhgReductionKg)).toFixed(2)],
      ['Grid CO2 Emissions (kg)', parseFloat(String(totals.ghgPreventedKg)).toFixed(2)],
      ['Gasoline CO2 Avoided (kg)', parseFloat(String(totals.gasolineCo2Kg)).toFixed(2)],
      ['EV Miles Enabled', parseFloat(String(totals.evMiles)).toFixed(2)],
      ['Gasoline Gallons Displaced', parseFloat(String(totals.gallonsDisplaced)).toFixed(2)],
      [],
      ['Configuration'],
      ['Grid Emission Factor (kg CO2/kWh)', cfg.gridEmissionFactor],
      ['EV Efficiency (miles/kWh)', cfg.evEfficiency],
      ['Gasoline Emission Factor (kg CO2/gal)', cfg.gasolineEmissionFactor],
      ['Average Vehicle MPG', cfg.avgMpg],
      [],
      ['By Site'],
      ['Site', 'Energy (kWh)', 'Sessions', 'Net GHG Reduction (kg CO2)'],
    ];
    for (const r of bySite) {
      const siteStats = computeSustainability(r.energyKwh, cfg);
      rows.push([
        r.siteName,
        parseFloat(String(r.energyKwh)).toFixed(2),
        r.sessionCount,
        parseFloat(String(siteStats.netGhgReductionKg)).toFixed(2),
      ]);
    }
    rows.push([]);
    rows.push(['Daily Energy']);
    rows.push(['Date', 'Energy (kWh)', 'Net GHG Reduction (kg CO2)']);
    for (const r of byDay) {
      const dayStats = computeSustainability(r.energyKwh, cfg);
      rows.push([
        r.date,
        parseFloat(String(r.energyKwh)).toFixed(2),
        parseFloat(String(dayStats.netGhgReductionKg)).toFixed(2),
      ]);
    }

    const csv = buildCsv(headers, rows);
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `sustainability-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      {
        name: 'Summary',
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Energy Delivered (kWh)', totalKwh.toFixed(2)],
          ['Net GHG Reduction (kg CO2)', parseFloat(String(totals.netGhgReductionKg)).toFixed(2)],
          ['Grid CO2 Emissions (kg)', parseFloat(String(totals.ghgPreventedKg)).toFixed(2)],
          ['Gasoline CO2 Avoided (kg)', parseFloat(String(totals.gasolineCo2Kg)).toFixed(2)],
          ['EV Miles Enabled', parseFloat(String(totals.evMiles)).toFixed(2)],
          ['Gasoline Gallons Displaced', parseFloat(String(totals.gallonsDisplaced)).toFixed(2)],
        ],
      },
      {
        name: 'Configuration',
        headers: ['Parameter', 'Value'],
        rows: [
          ['Grid Emission Factor (kg CO2/kWh)', cfg.gridEmissionFactor],
          ['EV Efficiency (miles/kWh)', cfg.evEfficiency],
          ['Gasoline Emission Factor (kg CO2/gal)', cfg.gasolineEmissionFactor],
          ['Average Vehicle MPG', cfg.avgMpg],
        ],
      },
      {
        name: 'By Site',
        headers: ['Site', 'Energy (kWh)', 'Sessions', 'Net GHG Reduction (kg CO2)'],
        rows: bySite.map((r) => {
          const siteStats = computeSustainability(r.energyKwh, cfg);
          return [
            r.siteName,
            parseFloat(String(r.energyKwh)).toFixed(2),
            r.sessionCount,
            parseFloat(String(siteStats.netGhgReductionKg)).toFixed(2),
          ];
        }),
      },
      {
        name: 'Daily Energy',
        headers: ['Date', 'Energy (kWh)', 'Net GHG Reduction (kg CO2)'],
        rows: byDay.map((r) => {
          const dayStats = computeSustainability(r.energyKwh, cfg);
          return [
            r.date,
            parseFloat(String(r.energyKwh)).toFixed(2),
            parseFloat(String(dayStats.netGhgReductionKg)).toFixed(2),
          ];
        }),
      },
    ]);
    return { data, fileName: `sustainability-report-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder();
  pdf.addTitle('Sustainability Report');
  pdf.addSubtitle(`Period: ${dateLabel}`);
  pdf.addSummaryRow('Total Energy Delivered:', `${totalKwh.toFixed(2)} kWh`);
  pdf.addSummaryRow(
    'Net GHG Reduction:',
    `${parseFloat(String(totals.netGhgReductionKg)).toFixed(2)} kg CO2`,
  );
  pdf.addSummaryRow('EV Miles Enabled:', parseFloat(String(totals.evMiles)).toFixed(0));
  pdf.addSummaryRow(
    'Gasoline Displaced:',
    `${parseFloat(String(totals.gallonsDisplaced)).toFixed(2)} gallons`,
  );

  pdf.addTable(
    ['Site', 'Energy (kWh)', 'Sessions', 'GHG Reduction (kg CO2)'],
    bySite.map((r) => {
      const s = computeSustainability(r.energyKwh, cfg);
      return [
        r.siteName,
        parseFloat(String(r.energyKwh)).toFixed(2),
        r.sessionCount,
        parseFloat(String(s.netGhgReductionKg)).toFixed(2),
      ];
    }),
  );

  pdf.addTable(
    ['Date', 'Energy (kWh)', 'GHG Reduction (kg CO2)'],
    byDay.map((r) => {
      const s = computeSustainability(r.energyKwh, cfg);
      return [
        r.date,
        parseFloat(String(r.energyKwh)).toFixed(2),
        parseFloat(String(s.netGhgReductionKg)).toFixed(2),
      ];
    }),
  );

  const data = await pdf.build();
  return { data, fileName: `sustainability-report-${String(Date.now())}.pdf` };
}
