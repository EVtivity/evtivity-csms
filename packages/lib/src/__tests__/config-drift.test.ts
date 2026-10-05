// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import { findTemplateTargetConfiguration } from '../config-drift.js';
import type { ReportedConfiguration } from '../config-drift.js';

function row(overrides: Partial<ReportedConfiguration>): ReportedConfiguration {
  return {
    component: 'TxCtrlr',
    instance: null,
    evseId: null,
    connectorId: null,
    variable: 'EVConnectionTimeOut',
    variableInstance: null,
    attributeType: 'Actual',
    value: '60',
    ...overrides,
  };
}

describe('findTemplateTargetConfiguration', () => {
  it('returns the top-level Actual row', () => {
    const target = row({ value: '30' });
    const rows = [
      row({ evseId: 1 }),
      row({ connectorId: 1, evseId: 1 }),
      row({ instance: 'Main' }),
      row({ variableInstance: 'Other' }),
      row({ attributeType: 'MaxSet' }),
      target,
    ];
    expect(findTemplateTargetConfiguration(rows, 'TxCtrlr', 'EVConnectionTimeOut')).toBe(target);
  });

  it('returns undefined when only other instances, EVSEs, or attributes exist', () => {
    const rows = [
      row({ evseId: 1 }),
      row({ variableInstance: 'Other' }),
      row({ attributeType: 'Target' }),
    ];
    expect(findTemplateTargetConfiguration(rows, 'TxCtrlr', 'EVConnectionTimeOut')).toBeUndefined();
  });

  it('matches an OCPP 1.6 template (no component) to the GetConfiguration row', () => {
    const target = row({ component: 'OCPP', variable: 'HeartbeatInterval', value: '300' });
    expect(findTemplateTargetConfiguration([target], '', 'HeartbeatInterval')).toBe(target);
  });
});
