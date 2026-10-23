// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts != null && 'tool' in opts
        ? `${key}(${String(opts.tool)})`
        : opts != null && 'hosts' in opts
          ? `${key}(${String(opts.hosts)})`
          : opts != null && 'count' in opts
            ? `${key}(${String(opts.count)})`
            : key,
  }),
}));

import { ConfirmActionCard, keyArguments, linkedHosts } from '../ConfirmActionCard';
import { ToolSteps } from '../ToolSteps';

afterEach(cleanup);

describe('ConfirmActionCard', () => {
  it('names the external hosts a text argument links to', () => {
    render(
      <ConfirmActionCard
        confirmation={{
          state: 'pending',
          event: {
            type: 'confirmation_required',
            actionId: 'act1',
            toolCallId: 't1',
            name: 'upsert_notification_template',
            nonce: 'n'.repeat(32),
            method: 'PUT',
            path: '/v1/notification-templates',
            summary: 'PUT /v1/notification-templates',
            arguments: {
              eventType: 'session.Receipt',
              bodyHtml: `<p>${'Thanks. '.repeat(40)}<a href="https://attacker.example/pay">update your card</a></p>`,
            },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }}
        canDecide
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-confirm-links').textContent).toBe(
      'ai.confirmLinks(attacker.example)',
    );
  });

  it('linkedHosts finds hosts at any depth, skips this CSMS and lists each once', () => {
    expect(
      linkedHosts(
        {
          a: 'see https://one.example/x and //two.example/y',
          b: [{ c: 'https:\\\\three.example', d: 'https://csms.local/ok' }],
          e: 'https://one.example/again',
          f: 42,
        },
        'csms.local',
      ),
    ).toEqual(['one.example', 'two.example', 'three.example']);
    expect(linkedHosts({ note: 'plain text' }, 'csms.local')).toEqual([]);
  });

  it('shows a localized summary with the tool name and the key arguments first', () => {
    render(
      <ConfirmActionCard
        confirmation={{
          state: 'pending',
          event: {
            type: 'confirmation_required',
            actionId: 'act1',
            toolCallId: 't1',
            name: 'update_station',
            nonce: 'n'.repeat(32),
            method: 'PATCH',
            path: '/v1/stations/sta_1',
            summary: 'PATCH /v1/stations/sta_1',
            arguments: { note: 'x'.repeat(80), id: 'sta_1', nested: { a: 1 } },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        }}
        canDecide
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-confirm-summary').textContent).toBe(
      'ai.confirmSummary.PATCH(update station)',
    );
    const terms = screen.getAllByRole('term').map((el) => el.textContent);
    expect(terms).toEqual(['id', 'note']);
    expect(screen.getByText(`${'x'.repeat(60)}...`)).toBeTruthy();
  });

  it('says how many values the card hides, and nothing when none are', () => {
    const event = {
      type: 'confirmation_required' as const,
      actionId: 'act1',
      toolCallId: 't1',
      name: 'upsert_notification_template',
      nonce: 'n'.repeat(32),
      method: 'PUT' as const,
      path: '/v1/notification-templates',
      summary: 'PUT /v1/notification-templates',
      arguments: { bodyHtml: '[redacted]' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const { rerender } = render(
      <ConfirmActionCard
        confirmation={{ state: 'pending', event: { ...event, maskedCount: 1 } }}
        canDecide
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByTestId('ai-confirm-masked').textContent).toBe('ai.confirmMaskedValues(1)');
    rerender(
      <ConfirmActionCard
        confirmation={{ state: 'pending', event }}
        canDecide
        onConfirm={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('ai-confirm-masked')).toBeNull();
  });

  it('keeps at most four scalar arguments', () => {
    const args = { a: 1, b: true, c: 'c', d: 'd', e: 'e', f: [1] };
    expect(keyArguments(args, '/v1/x').map((a) => a.key)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('ToolSteps', () => {
  it('shows a localized reason for a refused step instead of its summary', () => {
    render(
      <ToolSteps
        defaultOpen
        steps={[
          { toolCallId: 't1', name: 'list_settings', status: 'refused', reason: 'unavailable' },
          { toolCallId: 't2', name: 'get_station', status: 'refused', summary: 'raw' },
          { toolCallId: 't3', name: 'list_sites', status: 'ok', summary: 'GET /v1/sites 200' },
        ]}
      />,
    );
    expect(screen.getAllByText('ai.refusedReason.unavailable')).toHaveLength(2);
    expect(screen.queryByText('raw')).toBeNull();
    expect(screen.getByText('GET /v1/sites 200')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(screen.queryByText('list_sites')).toBeNull();
  });
});
