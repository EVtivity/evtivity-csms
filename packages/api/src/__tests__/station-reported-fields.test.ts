// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, expect, it } from 'vitest';
import { reportedFieldChange } from '../lib/station-reported-fields.js';

const booted = {
  model: 'eM4 Twin',
  serialNumber: 'SN-1',
  modelReportedAt: new Date('2026-11-01T00:00:00Z'),
  serialNumberReportedAt: new Date('2026-11-01T00:00:00Z'),
};

describe('reportedFieldChange', () => {
  it('allows every change before the first boot', () => {
    const fresh = { ...booted, modelReportedAt: null, serialNumberReportedAt: null };
    expect(reportedFieldChange(fresh, { model: 'Other', serialNumber: 'SN-2' })).toBeNull();
  });

  it('names the model, then the serial number, a write would change', () => {
    expect(reportedFieldChange(booted, { model: 'Other', serialNumber: 'SN-2' })).toBe('model');
    expect(reportedFieldChange(booted, { serialNumber: 'SN-2' })).toBe('serialNumber');
    expect(reportedFieldChange(booted, { serialNumber: null })).toBe('serialNumber');
  });

  it('passes the stored values and fields the write leaves out', () => {
    expect(reportedFieldChange(booted, { model: 'eM4 Twin', serialNumber: 'SN-1' })).toBeNull();
    expect(reportedFieldChange(booted, {})).toBeNull();
  });

  it('keeps the serial number editable when the boot reported none', () => {
    const noSerial = { ...booted, serialNumber: null, serialNumberReportedAt: null };
    expect(reportedFieldChange(noSerial, { serialNumber: 'SN-LABEL' })).toBeNull();
    expect(reportedFieldChange(noSerial, { model: 'Other' })).toBe('model');
  });
});
