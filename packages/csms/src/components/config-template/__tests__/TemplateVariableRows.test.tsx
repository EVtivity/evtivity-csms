// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

import { ApiError } from '@/lib/api';
import {
  TemplateVariableRows,
  duplicateVariableIndexes,
  isBootOwnedRefusal,
  templateVariablesForSave,
} from '../TemplateVariableRows';
import type { TemplateVariable } from '../TemplateVariableRows';

afterEach(() => {
  cleanup();
});

describe('template variable helpers', () => {
  it('treats the variable instance as part of the identity on 2.1 only', () => {
    const rows: TemplateVariable[] = [
      {
        component: 'OCPPCommCtrlr',
        variable: 'MessageTimeout',
        variableInstance: 'Default',
        value: '30',
      },
      { component: 'OCPPCommCtrlr', variable: 'MessageTimeout', value: '30' },
      {
        component: 'OCPPCommCtrlr',
        variable: 'MessageTimeout',
        variableInstance: ' Default ',
        value: '60',
      },
    ];
    expect([...duplicateVariableIndexes(rows, '2.1')]).toEqual([2]);
    expect([...duplicateVariableIndexes(rows, '1.6')]).toEqual([1, 2]);
  });

  it('sends an instance only on 2.1 templates and only when set', () => {
    const rows: TemplateVariable[] = [
      {
        component: 'OCPPCommCtrlr',
        variable: 'MessageAttempts',
        variableInstance: ' TransactionEvent ',
        value: '3',
      },
      {
        component: 'OCPPCommCtrlr',
        variable: 'WebSocketPingInterval',
        variableInstance: '',
        value: '300',
      },
      { component: '', variable: '', value: '' },
    ];
    expect(templateVariablesForSave(rows, '2.1')).toEqual([
      {
        component: 'OCPPCommCtrlr',
        variable: 'MessageAttempts',
        variableInstance: 'TransactionEvent',
        value: '3',
      },
      { component: 'OCPPCommCtrlr', variable: 'WebSocketPingInterval', value: '300' },
    ]);
    expect(
      templateVariablesForSave(
        [{ component: '', variable: 'WebSocketPingInterval', variableInstance: 'x', value: '240' }],
        '1.6',
      ),
    ).toEqual([{ component: '', variable: 'WebSocketPingInterval', value: '240' }]);
  });

  it('recognizes the boot-owned refusal by code', () => {
    const refused = new ApiError(400, {
      error: 'x',
      code: 'DATA_PLAN_SETTING_IN_TEMPLATE',
      details: { variables: ['HeartbeatInterval'] },
    });
    expect(isBootOwnedRefusal(refused)).toBe(true);
    expect(isBootOwnedRefusal(new ApiError(400, { code: 'VALIDATION_ERROR' }))).toBe(false);
    expect(isBootOwnedRefusal(new Error('x'))).toBe(false);
  });
});

describe('TemplateVariableRows', () => {
  it('shows the variable instance field on 2.1 rows and not on 1.6 rows', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TemplateVariableRows
        idPrefix="t"
        ocppVersion="2.1"
        variables={[{ component: 'OCPPCommCtrlr', variable: 'MessageTimeout', value: '30' }]}
        onChange={onChange}
        bootOwnedRefused={false}
        showDuplicates={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('configTemplates.variableInstance'), {
      target: { value: 'Default' },
    });
    expect(onChange).toHaveBeenCalledWith([
      {
        component: 'OCPPCommCtrlr',
        variable: 'MessageTimeout',
        variableInstance: 'Default',
        value: '30',
      },
    ]);
    rerender(
      <TemplateVariableRows
        idPrefix="t"
        ocppVersion="1.6"
        variables={[{ component: '', variable: 'WebSocketPingInterval', value: '300' }]}
        onChange={onChange}
        bootOwnedRefused={false}
        showDuplicates={false}
      />,
    );
    expect(screen.queryByLabelText('configTemplates.variableInstance')).toBeNull();
  });

  it('marks a boot-owned row, in red after a refusal', () => {
    const props = {
      idPrefix: 't',
      ocppVersion: '1.6' as const,
      variables: [{ component: '', variable: 'HeartbeatInterval', value: '300' }],
      onChange: vi.fn(),
      showDuplicates: false,
    };
    const { rerender } = render(<TemplateVariableRows {...props} bootOwnedRefused={false} />);
    const note = screen.getByText(/dataPlan\.fromDataPlan:/);
    expect(note.className).toContain('text-muted-foreground');
    rerender(<TemplateVariableRows {...props} bootOwnedRefused />);
    expect(screen.getByText(/dataPlan\.fromDataPlan:/).className).toContain('text-destructive');
  });
});
