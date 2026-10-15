// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const publishOcppCommand = vi.fn();
const rejectFirmwareUpdate = vi.fn();
const applyFirmwareCampaignStationStatus = vi.fn();

vi.mock('@evtivity/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, publishOcppCommand: (...a: unknown[]) => publishOcppCommand(...a) };
});

vi.mock('../lib/firmware-updates.js', () => ({
  rejectFirmwareUpdate: (...a: unknown[]) => rejectFirmwareUpdate(...a),
  applyFirmwareCampaignStationStatus: (...a: unknown[]) => applyFirmwareCampaignStationStatus(...a),
}));

import { dispatchPendingFirmwareCampaigns } from '../lib/firmware-campaign-dispatch.js';

function claimRow(campaignId: string) {
  return {
    campaign_id: campaignId,
    firmware_url: `https://example.com/${campaignId}.bin`,
    signing_certificate: null,
    signature: null,
    retries: null,
    retry_interval: null,
    install_date_time: null,
  };
}

describe('dispatchPendingFirmwareCampaigns', () => {
  beforeEach(() => {
    publishOcppCommand.mockReset().mockResolvedValue(undefined);
    rejectFirmwareUpdate.mockReset().mockResolvedValue(null);
    applyFirmwareCampaignStationStatus.mockReset().mockResolvedValue({ campaignCompleted: false });
  });

  it('ends a claimed row whose insert fails and still sends the next campaign', async () => {
    let call = 0;
    const sql = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve([claimRow('fwc_a'), claimRow('fwc_b')]);
      if (call === 2) return Promise.reject(new Error('insert failed'));
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    const warn = vi.fn();

    const sent = await dispatchPendingFirmwareCampaigns(
      sql,
      {} as never,
      { stationUuid: 'sta_1', stationOcppId: 'CS-1' },
      { warn },
    );

    expect(sent).toEqual(['fwc_b']);
    expect(publishOcppCommand).toHaveBeenCalledTimes(1);
    expect(rejectFirmwareUpdate).toHaveBeenCalledTimes(1);
    expect(applyFirmwareCampaignStationStatus).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        campaignId: 'fwc_a',
        stationUuid: 'sta_1',
        status: 'failed',
        errorInfo: 'CommandFailed',
      }),
    );
    expect(warn).toHaveBeenCalled();
  });

  it('keeps going when recording the failure itself fails', async () => {
    let call = 0;
    const sql = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve([claimRow('fwc_a')]);
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    publishOcppCommand.mockRejectedValueOnce(new Error('redis down'));
    rejectFirmwareUpdate.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();

    await expect(
      dispatchPendingFirmwareCampaigns(
        sql,
        {} as never,
        { stationUuid: 'sta_1', stationOcppId: 'CS-1' },
        { warn },
      ),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
