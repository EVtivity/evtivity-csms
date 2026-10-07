// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as templateVariables from '@/lib/template-variables';

const { layoutProps } = vi.hoisted(() => ({
  layoutProps: [] as Array<{ sections: Array<{ title: string; events: readonly string[] }> }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({ api: { get: vi.fn().mockResolvedValue([]), put: vi.fn() } }));

vi.mock('@/lib/auth', () => ({ useHasPermission: () => true }));

vi.mock('@/components/EventSettingsLayout', () => ({
  EventSettingsLayout: (props: {
    sections: Array<{ title: string; events: readonly string[] }>;
  }): null => {
    layoutProps.push(props);
    return null;
  },
}));

import { DriverEvents } from '../DriverEvents';

// Events with templates that are not driver notifications.
// report.Scheduled is the scheduled report email the worker renders; it has no event settings.
const NON_DRIVER_TEMPLATE_EVENTS = new Set<string>([
  ...templateVariables.OPERATOR_EVENT_TYPES,
  'report.Scheduled',
]);

function driverGroups(): Array<[string, readonly string[]]> {
  const groups: Array<[string, readonly string[]]> = [];
  for (const [name, value] of Object.entries(templateVariables) as Array<[string, unknown]>) {
    if (/^DRIVER_[A-Z_]+_EVENTS$/.test(name) && Array.isArray(value)) {
      groups.push([name, value as readonly string[]]);
    }
  }
  return groups;
}

function renderedSections(): Array<{ title: string; events: readonly string[] }> {
  layoutProps.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DriverEvents />
    </QueryClientProvider>,
  );
  const props = layoutProps.at(-1);
  if (props == null) throw new Error('EventSettingsLayout was not rendered');
  return props.sections;
}

// Every event with a shipped template: {api,ocpp}/src/templates/en/<family>/<Event>/<channel>.hbs.
// OCPP and station events are on the OCPP Events tab.
const TEMPLATE_FILES = import.meta.glob([
  '../../../../api/src/templates/en/*/*/*.hbs',
  '../../../../ocpp/src/templates/en/*/*/*.hbs',
  '!../../../../ocpp/src/templates/en/ocpp/**',
  '!../../../../ocpp/src/templates/en/station/**',
]);

function templateEventTypes(): string[] {
  const events = new Set<string>();
  for (const path of Object.keys(TEMPLATE_FILES)) {
    const [family, event] = path.split('/').slice(-3, -1);
    if (family != null && event != null) events.add(`${family}.${event}`);
  }
  return [...events];
}

describe('DriverEvents', () => {
  it('renders every DRIVER_*_EVENTS group from template-variables', () => {
    const groups = driverGroups();
    expect(groups.length).toBeGreaterThan(0);
    const sections = renderedSections();
    for (const [name, events] of groups) {
      expect(
        sections.some((s) => s.events === events),
        `${name} is not rendered on the Driver Events page`,
      ).toBe(true);
    }
    expect(sections).toHaveLength(groups.length);
  });

  it('lists every group in DRIVER_EVENT_TYPES', () => {
    const grouped = driverGroups().flatMap(([, events]) => events);
    expect([...grouped].sort()).toEqual([...templateVariables.DRIVER_EVENT_TYPES].sort());
  });

  it('puts every driver event with templates in a group', () => {
    const grouped = new Set<string>(driverGroups().flatMap(([, events]) => events));
    const templated = templateEventTypes();
    expect(templated).toContain('token.Reactivated');
    const missing = templated.filter((e) => !NON_DRIVER_TEMPLATE_EVENTS.has(e) && !grouped.has(e));
    expect(missing).toEqual([]);
  });

  it('has template variables for every driver event', () => {
    for (const event of templateVariables.DRIVER_EVENT_TYPES) {
      expect(templateVariables.TEMPLATE_VARIABLES[event], event).toBeDefined();
    }
  });
});
