// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import {
  siteInsightsOperatorSuppressedSql,
  siteInsightsSuppressedSql,
  siteInsightSuppressionSourcesSql,
  siteUnderActiveMaintenanceSql,
  stationInsightsOperatorSuppressedSql,
  stationInsightsSuppressedSql,
  stationInsightSuppressionSourcesSql,
  stationSiteInsightsSuppressedSql,
  stationUnderActiveMaintenanceSql,
} from '../lib/ai-insight-suppression.js';

describe('AI insight suppression predicates', () => {
  it('holds an operator suppression while suppressed_at is set and the end date is null or ahead', () => {
    const sql = stationInsightsOperatorSuppressedSql('cs');
    expect(sql).toContain('cs.ai_insights_suppressed_at IS NOT NULL');
    expect(sql).toContain('cs.ai_insights_suppressed_until IS NULL');
    expect(sql).toContain('cs.ai_insights_suppressed_until > now()');
    expect(siteInsightsOperatorSuppressedSql('s')).toContain(
      's.ai_insights_suppressed_at IS NOT NULL',
    );
  });

  it('reads the site of the station for the site source', () => {
    const sql = stationSiteInsightsSuppressedSql('cs');
    expect(sql).toContain('FROM sites ais_site');
    expect(sql).toContain('ais_site.id = cs.site_id');
    expect(sql).toContain('ais_site.ai_insights_suppressed_until > now()');
  });

  it('suppresses a station through the station, its site or an active maintenance event', () => {
    const sql = stationInsightsSuppressedSql('cs');
    expect(sql).toContain(stationInsightsOperatorSuppressedSql('cs'));
    expect(sql).toContain(stationSiteInsightsSuppressedSql('cs'));
    expect(sql).toContain(stationUnderActiveMaintenanceSql('cs'));
    expect(sql.split(' OR EXISTS').length).toBeGreaterThanOrEqual(3);
  });

  it('suppresses a site through its own suppression or a whole-site maintenance event', () => {
    const sql = siteInsightsSuppressedSql('sites');
    expect(sql).toContain(siteInsightsOperatorSuppressedSql('sites'));
    expect(sql).toContain(siteUnderActiveMaintenanceSql('sites'));
    // A maintenance event naming some stations does not suppress the site itself.
    expect(siteUnderActiveMaintenanceSql('sites')).toContain(
      "ais_me.affected_station_ids IS NULL OR ais_me.affected_station_ids = '{}'::text[]",
    );
    expect(siteUnderActiveMaintenanceSql('sites')).not.toContain('ANY(');
  });

  it('lists the sources in display order and drops the ones that do not hold', () => {
    const station = stationInsightSuppressionSourcesSql('cs');
    expect(station.indexOf("'station'")).toBeLessThan(station.indexOf("'site'"));
    expect(station.indexOf("'site'")).toBeLessThan(station.indexOf("'maintenance'"));
    expect(station).toContain('array_remove(');
    const site = siteInsightSuppressionSourcesSql('s');
    expect(site).toContain("THEN 'site'");
    expect(site).toContain("THEN 'maintenance'");
    expect(site).not.toContain("'station'");
  });
});
