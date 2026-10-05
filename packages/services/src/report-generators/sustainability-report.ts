// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { sql, and, eq, count, inArray } from 'drizzle-orm';
import {
  db,
  chargingSessions,
  chargingStations,
  sites,
  settings,
  getSystemTimezone,
} from '@evtivity/database';
import { buildCsv } from './csv-builder.js';
import { buildXlsx } from './xlsx-builder.js';
import { PdfReportBuilder } from './pdf-builder.js';
import type { UiLanguage } from '@evtivity/lib/languages';
import type { ReportGeneratorResult } from '../report.service.js';
import { csvRows, dateCell, fixedCell, pdfRows } from './report-cells.js';
import { reportLocale } from './report-locale.js';

// EPA defaults
const DEFAULT_GRID_EMISSION_FACTOR = 0.386; // kg CO2/kWh (US average)
const DEFAULT_EV_EFFICIENCY = 3.3; // miles/kWh
const DEFAULT_GASOLINE_EMISSION_FACTOR = 8.887; // kg CO2/gallon
const DEFAULT_AVG_MPG = 25.4; // US average fuel economy

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Filters {
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  siteId?: string | undefined;
}

function parseFilters(raw: Record<string, unknown>): Filters {
  const dateFromRaw = typeof raw['dateFrom'] === 'string' ? raw['dateFrom'] : undefined;
  const dateToRaw = typeof raw['dateTo'] === 'string' ? raw['dateTo'] : undefined;
  return {
    dateFrom: dateFromRaw != null && ISO_DATE.test(dateFromRaw) ? dateFromRaw : undefined,
    dateTo: dateToRaw != null && ISO_DATE.test(dateToRaw) ? dateToRaw : undefined,
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

interface EnergyBySite {
  siteName: string;
  energyKwh: number;
  sessionCount: number;
}

interface EnergyByDay {
  date: string;
  energyKwh: number;
}

function buildDateConditions(filters: Filters, tz: string) {
  const conditions = [];
  // Compare startedAt projected into the system timezone so YYYY-MM-DD
  // filters mean "the operator's local day" instead of UTC midnight.
  if (filters.dateFrom != null) {
    conditions.push(
      sql`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo != null) {
    conditions.push(
      sql`(${chargingSessions.startedAt} AT TIME ZONE ${tz})::date <= ${filters.dateTo}::date`,
    );
  }
  return conditions;
}

async function queryEnergyBySite(
  filters: Filters,
  tz: string,
  noSite: string,
): Promise<EnergyBySite[]> {
  const conditions = buildDateConditions(filters, tz);
  if (filters.siteId != null) {
    conditions.push(eq(chargingStations.siteId, filters.siteId));
  }

  const rows = await db
    .select({
      siteName: sql<string>`coalesce(${sites.name}, ${noSite})`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)::float8`,
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
  const conditions = buildDateConditions(filters, tz);
  // Honour the same siteId filter the per-site section uses, otherwise the
  // daily breakdown shows cross-site totals while the per-site table only
  // shows one site.
  if (filters.siteId != null) {
    const rows = await db
      .select({
        date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
        energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)::float8`,
      })
      .from(chargingSessions)
      .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
      .where(and(...conditions, eq(chargingStations.siteId, filters.siteId)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows;
  }

  const rows = await db
    .select({
      date: sql<string>`date_trunc('day', ${chargingSessions.startedAt} AT TIME ZONE ${tz})::date::text`,
      energyKwh: sql<number>`coalesce(sum(${chargingSessions.energyDeliveredWh}::numeric / 1000), 0)::float8`,
    })
    .from(chargingSessions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows;
}

function siteRow(r: EnergyBySite, cfg: SustainabilitySettings): unknown[] {
  const s = computeSustainability(r.energyKwh, cfg);
  return [r.siteName, fixedCell(r.energyKwh, 2), r.sessionCount, fixedCell(s.netGhgReductionKg, 2)];
}

function dayRow(r: EnergyByDay, cfg: SustainabilitySettings): unknown[] {
  const s = computeSustainability(r.energyKwh, cfg);
  return [dateCell(r.date), fixedCell(r.energyKwh, 2), fixedCell(s.netGhgReductionKg, 2)];
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
  language: UiLanguage = 'en',
): Promise<ReportGeneratorResult> {
  const filters = parseFilters(rawFilters);
  const rl = reportLocale(language, format);
  const { common, columns } = rl.labels;
  const l = rl.labels.sustainability;
  const [cfg, tz] = await Promise.all([getSustainabilitySettings(), getSystemTimezone()]);

  const [bySite, byDay] = await Promise.all([
    queryEnergyBySite(filters, tz, common.noSite),
    queryEnergyByDay(filters, tz),
  ]);

  const totalKwh = bySite.reduce((sum, r) => sum + r.energyKwh, 0);
  const totals = computeSustainability(totalKwh, cfg);

  const metricHeaders = [l.columns.metric, l.columns.value];
  const metricRows: unknown[][] = [
    [l.metrics.totalEnergyDelivered, fixedCell(totalKwh, 2)],
    [l.metrics.netGhgReduction, fixedCell(totals.netGhgReductionKg, 2)],
    [l.metrics.gridCo2, fixedCell(totals.ghgPreventedKg, 2)],
    [l.metrics.gasolineCo2Avoided, fixedCell(totals.gasolineCo2Kg, 2)],
    [l.metrics.evMilesEnabled, fixedCell(totals.evMiles, 2)],
    [l.metrics.gasolineGallonsDisplaced, fixedCell(totals.gallonsDisplaced, 2)],
  ];
  const configRows: unknown[][] = [
    [l.metrics.gridEmissionFactor, cfg.gridEmissionFactor],
    [l.metrics.evEfficiency, cfg.evEfficiency],
    [l.metrics.gasolineEmissionFactor, cfg.gasolineEmissionFactor],
    [l.metrics.averageVehicleMpg, cfg.avgMpg],
  ];
  const siteHeaders = [
    columns.site,
    columns.energyKwh,
    columns.sessions,
    l.columns.netGhgReduction,
  ];
  const dayHeaders = [columns.date, columns.energyKwh, l.columns.netGhgReduction];

  if (format === 'csv') {
    const rows: unknown[][] = [
      ...metricRows,
      [],
      [l.sheets.configuration],
      ...configRows,
      [],
      [l.sheets.bySite],
      siteHeaders,
      ...bySite.map((r) => siteRow(r, cfg)),
      [],
      [l.sheets.dailyEnergy],
      dayHeaders,
      ...byDay.map((r) => dayRow(r, cfg)),
    ];
    const csv = buildCsv(metricHeaders, csvRows(rows));
    return {
      data: Buffer.from(csv, 'utf-8'),
      fileName: `sustainability-report-${String(Date.now())}.csv`,
    };
  } else if (format === 'xlsx') {
    const data = await buildXlsx([
      { name: l.sheets.summary, headers: metricHeaders, rows: metricRows },
      {
        name: l.sheets.configuration,
        headers: [l.columns.parameter, l.columns.value],
        rows: configRows,
      },
      { name: l.sheets.bySite, headers: siteHeaders, rows: bySite.map((r) => siteRow(r, cfg)) },
      { name: l.sheets.dailyEnergy, headers: dayHeaders, rows: byDay.map((r) => dayRow(r, cfg)) },
    ]);
    return { data, fileName: `sustainability-report-${String(Date.now())}.xlsx` };
  }

  const pdf = new PdfReportBuilder(rl.language);
  pdf.addTitle(l.title);
  pdf.addSubtitle(rl.period(filters.dateFrom, filters.dateTo, common.allTime));
  pdf.addSummaryRow(
    rl.summary(l.summary.totalEnergyDelivered),
    rl.fill(common.kwh, { value: rl.number(totalKwh, 2) }),
  );
  pdf.addSummaryRow(
    rl.summary(l.summary.netGhgReduction),
    rl.fill(l.units.kgCo2, { value: rl.number(totals.netGhgReductionKg, 2) }),
  );
  pdf.addSummaryRow(rl.summary(l.summary.evMilesEnabled), rl.number(totals.evMiles, 0));
  pdf.addSummaryRow(
    rl.summary(l.summary.gasolineDisplaced),
    rl.fill(l.units.gallons, { value: rl.number(totals.gallonsDisplaced, 2) }),
  );

  pdf.addTable(
    [columns.site, columns.energyKwh, columns.sessions, l.columns.ghgReduction],
    pdfRows(
      bySite.map((r) => siteRow(r, cfg)),
      rl,
    ),
  );

  pdf.addTable(
    [columns.date, columns.energyKwh, l.columns.ghgReduction],
    pdfRows(
      byDay.map((r) => dayRow(r, cfg)),
      rl,
    ),
  );

  const data = await pdf.build();
  return { data, fileName: `sustainability-report-${String(Date.now())}.pdf` };
}
