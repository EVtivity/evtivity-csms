// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import ExcelJS from 'exceljs';
import { sql, eq, and, gte, lte } from 'drizzle-orm';
import {
  db,
  chargingStations,
  sites,
  evses,
  connectors,
  chargingSessions,
  paymentRecords,
  neviStationData,
} from '@evtivity/database';

// ── Types ──────────────────────────────────────────────────────────────────────

interface QuarterDates {
  start: Date;
  end: Date;
  months: Array<{ month: number; year: number; start: Date; end: Date }>;
}

interface StationLocationRow {
  stationId: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  connectorType: string | null;
  maxPowerKw: number | null;
}

interface SessionRow {
  stationOcppId: string;
  evseOcppId: number | null;
  sessionStart: Date | null;
  sessionEnd: Date | null;
  energyWh: string | null;
  sessionId: string;
  status: string;
  stoppedReason: string | null;
  paymentSource: string | null;
}

interface PeakKwRow {
  sessionId: string;
  peakKw: string;
}

interface UptimeRow {
  station_id: string;
  evse_id: number;
  month_number: number;
  outage_minutes: string;
  excluded_minutes: string;
  minutes_in_month: string;
}

interface OutageRow {
  station_id: string;
  evse_id: number;
  start_time: string;
  end_time: string | null;
  duration_minutes: string | null;
  new_status: string;
}

interface MaintenanceCostRow {
  stationOcppId: string;
  maintenanceCostAnnual: string | null;
  maintenanceCostYear: number | null;
}

interface OperatorIdentityRow {
  stationOcppId: string;
  operatorName: string | null;
  operatorAddress: string | null;
  operatorPhone: string | null;
  operatorEmail: string | null;
}

interface OperatorProgramsRow {
  stationOcppId: string;
  programParticipation: unknown;
}

interface DerInfoRow {
  stationOcppId: string;
  derType: string | null;
  derCapacityKw: string | null;
  derCapacityKwh: string | null;
}

interface CapitalCostsRow {
  stationOcppId: string;
  installationCost: string | null;
  gridConnectionCost: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getQuarterDates(quarter: number, year: number): QuarterDates {
  const quarterMonths: Record<number, [number, number, number]> = {
    1: [0, 1, 2],
    2: [3, 4, 5],
    3: [6, 7, 8],
    4: [9, 10, 11],
  };

  const months = quarterMonths[quarter];
  if (months === undefined) {
    throw new Error(`Invalid quarter: ${String(quarter)}`);
  }

  const start = new Date(Date.UTC(year, months[0], 1));
  const endMonth = months[2];
  const lastDay = new Date(Date.UTC(year, endMonth + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(year, endMonth, lastDay, 23, 59, 59, 999));

  const monthDetails = months.map((m) => {
    const mStart = new Date(Date.UTC(year, m, 1));
    const mLastDay = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const mEnd = new Date(Date.UTC(year, m, mLastDay, 23, 59, 59, 999));
    return { month: m + 1, year, start: mStart, end: mEnd };
  });

  return { start, end, months: monthDetails };
}

function styleHeaderRow(sheet: ExcelJS.Worksheet): void {
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { horizontal: 'center' };
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9E1F2' },
    };
    cell.border = {
      bottom: { style: 'thin' },
    };
  });
}

function autoSizeColumns(sheet: ExcelJS.Worksheet): void {
  sheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const val = cell.value;
      const cellLength = (
        val != null ? (typeof val === 'object' ? JSON.stringify(val) : String(val)) : ''
      ).length;
      if (cellLength > maxLength) {
        maxLength = cellLength;
      }
    });
    column.width = Math.min(maxLength + 2, 50);
  });
}

// ── Tab 1: Station Location ────────────────────────────────────────────────────

async function buildStationLocationTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station Name', key: 'stationName' },
    { header: 'Address', key: 'address' },
    { header: 'City', key: 'city' },
    { header: 'State', key: 'state' },
    { header: 'ZIP', key: 'zip' },
    { header: 'Latitude', key: 'latitude' },
    { header: 'Longitude', key: 'longitude' },
    { header: 'Connector Types', key: 'connectorTypes' },
    { header: 'Max Power kW', key: 'maxPowerKw' },
  ];

  const rows = await db
    .select({
      stationId: chargingStations.stationId,
      address: sites.address,
      city: sites.city,
      state: sites.state,
      postalCode: sites.postalCode,
      latitude: sites.latitude,
      longitude: sites.longitude,
      connectorType: connectors.connectorType,
      maxPowerKw: connectors.maxPowerKw,
    })
    .from(chargingStations)
    .innerJoin(sites, eq(chargingStations.siteId, sites.id))
    .innerJoin(evses, eq(evses.stationId, chargingStations.id))
    .innerJoin(connectors, eq(connectors.evseId, evses.id));

  const stationMap = new Map<
    string,
    {
      address: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
      latitude: string | null;
      longitude: string | null;
      connectorTypes: Set<string>;
      maxPowerKw: number;
    }
  >();

  for (const row of rows as StationLocationRow[]) {
    let entry = stationMap.get(row.stationId);
    if (entry === undefined) {
      entry = {
        address: row.address,
        city: row.city,
        state: row.state,
        postalCode: row.postalCode,
        latitude: row.latitude,
        longitude: row.longitude,
        connectorTypes: new Set<string>(),
        maxPowerKw: 0,
      };
      stationMap.set(row.stationId, entry);
    }
    if (row.connectorType) {
      entry.connectorTypes.add(row.connectorType);
    }
    if (row.maxPowerKw !== null && row.maxPowerKw > entry.maxPowerKw) {
      entry.maxPowerKw = row.maxPowerKw;
    }
  }

  for (const [stationName, data] of stationMap) {
    sheet.addRow({
      stationName,
      address: data.address ?? '',
      city: data.city ?? '',
      state: data.state ?? '',
      zip: data.postalCode ?? '',
      latitude: data.latitude ?? '',
      longitude: data.longitude ?? '',
      connectorTypes: [...data.connectorTypes].join(', '),
      maxPowerKw: data.maxPowerKw,
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 2: Sessions ────────────────────────────────────────────────────────────

async function buildSessionsTab(sheet: ExcelJS.Worksheet, dates: QuarterDates): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'EVSE ID', key: 'evseId' },
    { header: 'Session Start', key: 'sessionStart' },
    { header: 'Session End', key: 'sessionEnd' },
    { header: 'Energy kWh', key: 'energyKwh' },
    { header: 'Peak kW', key: 'peakKw' },
    { header: 'Payment Method', key: 'paymentMethod' },
    { header: 'Error Code', key: 'errorCode' },
  ];

  const sessionRows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      evseOcppId: evses.evseId,
      sessionStart: chargingSessions.startedAt,
      sessionEnd: chargingSessions.endedAt,
      energyWh: chargingSessions.energyDeliveredWh,
      sessionId: chargingSessions.id,
      status: chargingSessions.status,
      stoppedReason: chargingSessions.stoppedReason,
      paymentSource: paymentRecords.paymentSource,
    })
    .from(chargingSessions)
    .innerJoin(chargingStations, eq(chargingSessions.stationId, chargingStations.id))
    .leftJoin(evses, eq(chargingSessions.evseId, evses.id))
    .leftJoin(paymentRecords, eq(paymentRecords.sessionId, chargingSessions.id))
    .where(
      and(gte(chargingSessions.startedAt, dates.start), lte(chargingSessions.startedAt, dates.end)),
    );

  const sessionIds = (sessionRows as SessionRow[]).map((r) => r.sessionId);

  const peakKwMap = new Map<string, number>();
  if (sessionIds.length > 0) {
    const peakRows = await db.execute(sql`
      SELECT
        session_id AS "sessionId",
        MAX(value) AS "peakKw"
      FROM meter_values
      WHERE session_id IN (${sql.join(
        sessionIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        AND measurand = 'Power.Active.Import'
      GROUP BY session_id
    `);

    for (const row of peakRows as unknown as PeakKwRow[]) {
      peakKwMap.set(row.sessionId, Number(row.peakKw));
    }
  }

  for (const row of sessionRows as SessionRow[]) {
    const energyKwh =
      row.energyWh !== null ? Math.round((Number(row.energyWh) / 1000) * 1000) / 1000 : '';
    const peakKw = peakKwMap.get(row.sessionId);
    const isFaultedOrInvalid = row.status === 'faulted' || row.status === 'invalid';

    sheet.addRow({
      stationId: row.stationOcppId,
      evseId: row.evseOcppId ?? '',
      sessionStart: row.sessionStart ? row.sessionStart.toISOString() : '',
      sessionEnd: row.sessionEnd ? row.sessionEnd.toISOString() : '',
      energyKwh,
      peakKw: peakKw !== undefined ? Math.round(peakKw * 1000) / 1000 : '',
      paymentMethod: row.paymentSource ?? '',
      errorCode: isFaultedOrInvalid ? (row.stoppedReason ?? '') : '',
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 3: Uptime ──────────────────────────────────────────────────────────────

async function buildUptimeTab(sheet: ExcelJS.Worksheet, dates: QuarterDates): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'EVSE ID', key: 'evseId' },
    { header: 'Month', key: 'month' },
    { header: 'Uptime %', key: 'uptimePercent' },
    { header: 'Outage Minutes', key: 'outageMinutes' },
    { header: 'Excluded Minutes', key: 'excludedMinutes' },
  ];

  for (const monthInfo of dates.months) {
    const monthStart = monthInfo.start.toISOString();
    const monthEnd = monthInfo.end.toISOString();
    const minutesInMonth = (monthInfo.end.getTime() - monthInfo.start.getTime() + 1) / 60000;
    const monthLabel = `${String(monthInfo.year)}-${String(monthInfo.month).padStart(2, '0')}`;

    const rows = await db.execute(sql`
      WITH port_transitions AS (
        SELECT
          psl.station_id,
          psl.evse_id,
          psl.new_status,
          psl.timestamp,
          LEAD(psl.timestamp) OVER (
            PARTITION BY psl.station_id, psl.evse_id
            ORDER BY psl.timestamp
          ) AS next_timestamp
        FROM port_status_log psl
        WHERE psl.timestamp <= ${monthEnd}::timestamptz
      ),
      outage_segments AS (
        SELECT
          pt.station_id,
          pt.evse_id,
          GREATEST(pt.timestamp, ${monthStart}::timestamptz) AS seg_start,
          LEAST(COALESCE(pt.next_timestamp, ${monthEnd}::timestamptz), ${monthEnd}::timestamptz) AS seg_end
        FROM port_transitions pt
        WHERE pt.new_status IN ('faulted', 'unavailable')
          AND pt.timestamp < ${monthEnd}::timestamptz
          AND COALESCE(pt.next_timestamp, ${monthEnd}::timestamptz) > ${monthStart}::timestamptz
      ),
      outage_per_port AS (
        SELECT
          station_id,
          evse_id,
          SUM(EXTRACT(EPOCH FROM (seg_end - seg_start)) / 60) AS outage_minutes
        FROM outage_segments
        GROUP BY station_id, evse_id
      ),
      excluded_segments AS (
        SELECT
          ned.station_id,
          ned.evse_id,
          GREATEST(ned.started_at, ${monthStart}::timestamptz) AS seg_start,
          LEAST(COALESCE(ned.ended_at, ${monthEnd}::timestamptz), ${monthEnd}::timestamptz) AS seg_end
        FROM nevi_excluded_downtime ned
        WHERE ned.started_at < ${monthEnd}::timestamptz
          AND COALESCE(ned.ended_at, ${monthEnd}::timestamptz) > ${monthStart}::timestamptz
      ),
      excluded_per_port AS (
        SELECT
          station_id,
          evse_id,
          SUM(EXTRACT(EPOCH FROM (seg_end - seg_start)) / 60) AS excluded_minutes
        FROM excluded_segments
        GROUP BY station_id, evse_id
      ),
      all_ports AS (
        SELECT DISTINCT station_id, evse_id FROM evses
      )
      SELECT
        cs.station_id AS station_id,
        ap.evse_id AS evse_id,
        ${monthInfo.month} AS month_number,
        COALESCE(opp.outage_minutes, 0) AS outage_minutes,
        COALESCE(epp.excluded_minutes, 0) AS excluded_minutes,
        ${minutesInMonth} AS minutes_in_month
      FROM all_ports ap
      INNER JOIN charging_stations cs ON cs.id = ap.station_id
      LEFT JOIN outage_per_port opp
        ON opp.station_id = ap.station_id AND opp.evse_id = ap.evse_id
      LEFT JOIN excluded_per_port epp
        ON epp.station_id = ap.station_id AND epp.evse_id = ap.evse_id
    `);

    for (const row of rows as unknown as UptimeRow[]) {
      const outageMinutes = Number(row.outage_minutes);
      const excludedMinutes = Math.min(Number(row.excluded_minutes), outageMinutes);
      const totalMinutes = Number(row.minutes_in_month);
      const adjustedOutage = outageMinutes - excludedMinutes;
      const uptimePercent =
        totalMinutes > 0
          ? Math.round(((totalMinutes - adjustedOutage) / totalMinutes) * 10000) / 100
          : 100;

      sheet.addRow({
        stationId: row.station_id,
        evseId: row.evse_id,
        month: monthLabel,
        uptimePercent,
        outageMinutes: Math.round(outageMinutes * 100) / 100,
        excludedMinutes: Math.round(excludedMinutes * 100) / 100,
      });
    }
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 4: Outage ──────────────────────────────────────────────────────────────

async function buildOutageTab(sheet: ExcelJS.Worksheet, dates: QuarterDates): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'EVSE ID', key: 'evseId' },
    { header: 'Start Time', key: 'startTime' },
    { header: 'End Time', key: 'endTime' },
    { header: 'Duration Minutes', key: 'durationMinutes' },
    { header: 'Status', key: 'status' },
  ];

  const startIso = dates.start.toISOString();
  const endIso = dates.end.toISOString();

  const rows = await db.execute(sql`
    WITH transitions AS (
      SELECT
        cs.station_id AS station_id,
        psl.evse_id,
        psl.new_status,
        psl.timestamp,
        LEAD(psl.timestamp) OVER (
          PARTITION BY psl.station_id, psl.evse_id
          ORDER BY psl.timestamp
        ) AS next_timestamp
      FROM port_status_log psl
      INNER JOIN charging_stations cs ON cs.id = psl.station_id
      WHERE psl.timestamp >= ${startIso}::timestamptz
        AND psl.timestamp <= ${endIso}::timestamptz
    )
    SELECT
      station_id,
      evse_id,
      timestamp AS start_time,
      next_timestamp AS end_time,
      CASE
        WHEN next_timestamp IS NOT NULL
        THEN EXTRACT(EPOCH FROM (next_timestamp - timestamp)) / 60
        ELSE NULL
      END AS duration_minutes,
      new_status
    FROM transitions
    WHERE new_status IN ('faulted', 'unavailable')
    ORDER BY station_id, evse_id, timestamp
  `);

  for (const row of rows as unknown as OutageRow[]) {
    sheet.addRow({
      stationId: row.station_id,
      evseId: row.evse_id,
      startTime: row.start_time,
      endTime: row.end_time ?? '',
      durationMinutes:
        row.duration_minutes !== null ? Math.round(Number(row.duration_minutes) * 100) / 100 : '',
      status: row.new_status,
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 5: Maintenance Cost ────────────────────────────────────────────────────

async function buildMaintenanceCostTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'Annual Maintenance Cost', key: 'annualMaintenanceCost' },
    { header: 'Cost Year', key: 'costYear' },
  ];

  const rows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      maintenanceCostAnnual: neviStationData.maintenanceCostAnnual,
      maintenanceCostYear: neviStationData.maintenanceCostYear,
    })
    .from(neviStationData)
    .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id));

  for (const row of rows as MaintenanceCostRow[]) {
    sheet.addRow({
      stationId: row.stationOcppId,
      annualMaintenanceCost:
        row.maintenanceCostAnnual !== null ? Number(row.maintenanceCostAnnual) : '',
      costYear: row.maintenanceCostYear ?? '',
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 6: Station Operator Identity ───────────────────────────────────────────

async function buildOperatorIdentityTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'Operator Name', key: 'operatorName' },
    { header: 'Operator Address', key: 'operatorAddress' },
    { header: 'Operator Phone', key: 'operatorPhone' },
    { header: 'Operator Email', key: 'operatorEmail' },
  ];

  const rows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      operatorName: neviStationData.operatorName,
      operatorAddress: neviStationData.operatorAddress,
      operatorPhone: neviStationData.operatorPhone,
      operatorEmail: neviStationData.operatorEmail,
    })
    .from(neviStationData)
    .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id));

  for (const row of rows as OperatorIdentityRow[]) {
    sheet.addRow({
      stationId: row.stationOcppId,
      operatorName: row.operatorName ?? '',
      operatorAddress: row.operatorAddress ?? '',
      operatorPhone: row.operatorPhone ?? '',
      operatorEmail: row.operatorEmail ?? '',
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 7: Station Operator Programs ───────────────────────────────────────────

async function buildOperatorProgramsTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'Programs', key: 'programs' },
  ];

  const rows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      programParticipation: neviStationData.programParticipation,
    })
    .from(neviStationData)
    .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id));

  for (const row of rows as OperatorProgramsRow[]) {
    let programs = '';
    if (Array.isArray(row.programParticipation)) {
      programs = (row.programParticipation as string[]).join(', ');
    }
    sheet.addRow({
      stationId: row.stationOcppId,
      programs,
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 8: DER Info ────────────────────────────────────────────────────────────

async function buildDerInfoTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'DER Type', key: 'derType' },
    { header: 'Capacity kW', key: 'capacityKw' },
    { header: 'Capacity kWh', key: 'capacityKwh' },
  ];

  const rows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      derType: neviStationData.derType,
      derCapacityKw: neviStationData.derCapacityKw,
      derCapacityKwh: neviStationData.derCapacityKwh,
    })
    .from(neviStationData)
    .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id));

  for (const row of rows as DerInfoRow[]) {
    sheet.addRow({
      stationId: row.stationOcppId,
      derType: row.derType ?? '',
      capacityKw: row.derCapacityKw !== null ? Number(row.derCapacityKw) : '',
      capacityKwh: row.derCapacityKwh !== null ? Number(row.derCapacityKwh) : '',
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Tab 9: Capital/Installation Costs ──────────────────────────────────────────

async function buildCapitalCostsTab(sheet: ExcelJS.Worksheet): Promise<void> {
  sheet.columns = [
    { header: 'Station ID', key: 'stationId' },
    { header: 'Installation Cost', key: 'installationCost' },
    { header: 'Grid Connection Cost', key: 'gridConnectionCost' },
  ];

  const rows = await db
    .select({
      stationOcppId: chargingStations.stationId,
      installationCost: neviStationData.installationCost,
      gridConnectionCost: neviStationData.gridConnectionCost,
    })
    .from(neviStationData)
    .innerJoin(chargingStations, eq(neviStationData.stationId, chargingStations.id));

  for (const row of rows as CapitalCostsRow[]) {
    sheet.addRow({
      stationId: row.stationOcppId,
      installationCost: row.installationCost !== null ? Number(row.installationCost) : '',
      gridConnectionCost: row.gridConnectionCost !== null ? Number(row.gridConnectionCost) : '',
    });
  }

  styleHeaderRow(sheet);
  autoSizeColumns(sheet);
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function generateNeviReport(
  filters: Record<string, unknown>,
  format: string,
): Promise<{ data: Buffer; fileName: string }> {
  // NEVI reports are always XLSX (EV-ChART format); format parameter is part of the generator interface
  void format;
  const quarter = Number(filters['quarter']);
  const year = Number(filters['year']);

  if (
    !Number.isInteger(quarter) ||
    quarter < 1 ||
    quarter > 4 ||
    !Number.isInteger(year) ||
    year < 2000
  ) {
    throw new Error('Filters must include a valid quarter (1-4) and year');
  }

  const dates = getQuarterDates(quarter, year);
  const workbook = new ExcelJS.Workbook();

  const stationLocationSheet = workbook.addWorksheet('Station Location');
  const sessionsSheet = workbook.addWorksheet('Sessions');
  const uptimeSheet = workbook.addWorksheet('Uptime');
  const outageSheet = workbook.addWorksheet('Outage');
  const maintenanceCostSheet = workbook.addWorksheet('Maintenance Cost');
  const operatorIdentitySheet = workbook.addWorksheet('Station Operator Identity');
  const operatorProgramsSheet = workbook.addWorksheet('Station Operator Programs');
  const derInfoSheet = workbook.addWorksheet('DER Info');
  const capitalCostsSheet = workbook.addWorksheet('Capital-Installation Costs');

  await Promise.all([
    buildStationLocationTab(stationLocationSheet),
    buildSessionsTab(sessionsSheet, dates),
    buildUptimeTab(uptimeSheet, dates),
    buildOutageTab(outageSheet, dates),
    buildMaintenanceCostTab(maintenanceCostSheet),
    buildOperatorIdentityTab(operatorIdentitySheet),
    buildOperatorProgramsTab(operatorProgramsSheet),
    buildDerInfoTab(derInfoSheet),
    buildCapitalCostsTab(capitalCostsSheet),
  ]);

  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = `NEVI_EV-ChART_Q${String(quarter)}_${String(year)}.xlsx`;

  return { data: Buffer.from(buffer), fileName };
}
