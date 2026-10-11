// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DRIVER_AI_NOTICE_VERSION } from '@evtivity/lib/driver-ai';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ko from '../../i18n/locales/ko.json';
import zh from '../../i18n/locales/zh.json';
import zhTW from '../../i18n/locales/zh-TW.json';

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return { api: { get: getMock, post: postMock }, ApiError };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de', resolvedLanguage: 'de', changeLanguage: vi.fn() },
  }),
}));

import { ApiError } from '@/lib/api';
import { NewSupportCase } from '../NewSupportCase';

const NOTICE = `supportCases.ai.notice.v${String(DRIVER_AI_NOTICE_VERSION)}`;

function features(driverAiSupport: boolean, version = DRIVER_AI_NOTICE_VERSION): void {
  getMock.mockResolvedValue({
    supportEnabled: true,
    reservationEnabled: true,
    driverAiSupport,
    driverAiNoticeVersion: version,
  });
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/support/new']}>
        <NewSupportCase />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillAndSubmit(): void {
  fireEvent.change(screen.getByLabelText('supportCases.subject'), {
    target: { value: 'Charging stopped' },
  });
  fireEvent.change(screen.getByLabelText('supportCases.description'), {
    target: { value: 'It stopped after 2 minutes.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'supportCases.submitCase' }));
}

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
});

describe('NewSupportCase driver AI consent', () => {
  it('TC-AI-DR-UI-01: shows the consent step only with driverAiSupport, two equal buttons, nothing preselected', async () => {
    features(true);
    renderPage();
    const ai = await screen.findByRole('button', { name: 'supportCases.ai.choiceAi' });
    const team = screen.getByRole('button', { name: 'supportCases.ai.choiceTeam' });
    // Equal weight: the same classes, no pressed or default state.
    expect(ai.className).toBe(team.className);
    expect(ai.getAttribute('aria-pressed')).toBeNull();
    expect(team.getAttribute('aria-pressed')).toBeNull();
    // The form is not shown until a choice is pressed.
    expect(screen.queryByLabelText('supportCases.subject')).toBeNull();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('TC-AI-DR-UI-01: the notice lists what the AI reads and links the privacy policy', async () => {
    features(true);
    renderPage();
    await screen.findByText(`${NOTICE}.title`);
    for (const point of ['automated', 'provider', 'person', 'choice']) {
      expect(screen.getByText(`${NOTICE}.${point}`)).toBeTruthy();
    }
    expect(screen.getByText(`${NOTICE}.readsTitle`)).toBeTruthy();
    for (const item of ['case', 'sessions', 'tokens', 'payments', 'stations', 'reservations']) {
      expect(screen.getByText(`${NOTICE}.reads.${item}`)).toBeTruthy();
    }
    const privacy = screen.getByRole('link', { name: `${NOTICE}.privacy` });
    expect(privacy.getAttribute('href')).toBe('/privacy-policy');
  });

  it('TC-AI-AD-13: the consent notice shows the driver AI data note, not the operator one', async () => {
    features(true);
    renderPage();
    expect(await screen.findByText('supportCases.ai.dataNotice.title')).toBeTruthy();
    expect(screen.getByText('supportCases.ai.dataNotice.body')).toBeTruthy();
    expect(screen.queryByText('ai.dataNotice.body')).toBeNull();
  });

  it('TC-AI-AD-13: the data note keys are present in all six locales', () => {
    for (const [lang, locale] of Object.entries({ en, de, es, ko, zh, 'zh-TW': zhTW })) {
      const notice = (
        locale as {
          supportCases?: { ai?: { dataNotice?: { title?: string; body?: string } } };
        }
      ).supportCases?.ai?.dataNotice;
      expect(notice?.title, lang).toBeTruthy();
      expect(notice?.body, lang).toBeTruthy();
    }
  });

  it('TC-AI-DR-UI-01: "Ask AI first" sends a granted consent with the notice version and UI language', async () => {
    features(true);
    postMock.mockResolvedValue({ id: 'case-1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.choiceAi' }));
    fillAndSubmit();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    expect(postMock).toHaveBeenCalledWith(
      '/v1/portal/support-cases',
      expect.objectContaining({
        aiConsent: { decision: 'granted', noticeVersion: DRIVER_AI_NOTICE_VERSION, language: 'de' },
      }),
    );
  });

  it('TC-AI-DR-UI-01: "Send to the team" sends a declined consent', async () => {
    features(true);
    postMock.mockResolvedValue({ id: 'case-1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.choiceTeam' }));
    fillAndSubmit();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as { aiConsent?: { decision: string } };
    expect(body.aiConsent?.decision).toBe('declined');
  });

  it('TC-AI-DR-UI-01: the choice can be changed before sending, and nothing is sent until a press', async () => {
    features(true);
    postMock.mockResolvedValue({ id: 'case-1' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.choiceAi' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'supportCases.ai.changeChoice: supportCases.ai.choiceAi',
      }),
    );
    // Back on the choice: no form, no request.
    expect(screen.getByRole('button', { name: 'supportCases.ai.choiceTeam' })).toBeTruthy();
    expect(screen.queryByLabelText('supportCases.subject')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'supportCases.ai.choiceTeam' }));
    fillAndSubmit();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    const body = postMock.mock.calls[0]?.[1] as { aiConsent?: { decision: string } };
    expect(body.aiConsent?.decision).toBe('declined');
  });

  it('TC-AI-DR-UI-01: with the feature off the form is unchanged and sends no consent', async () => {
    features(false);
    postMock.mockResolvedValue({ id: 'case-1' });
    renderPage();
    await screen.findByLabelText('supportCases.subject');
    expect(screen.queryByRole('button', { name: 'supportCases.ai.choiceAi' })).toBeNull();
    fillAndSubmit();
    await waitFor(() => {
      expect(postMock).toHaveBeenCalledTimes(1);
    });
    expect(postMock.mock.calls[0]?.[1]).not.toHaveProperty('aiConsent');
  });

  it('TC-AI-DR-UI-01: shows no form while the features load, so consent always comes first', () => {
    getMock.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.queryByLabelText('supportCases.subject')).toBeNull();
    expect(screen.queryByRole('button', { name: 'supportCases.ai.choiceAi' })).toBeNull();
  });

  it('TC-AI-DR-UI-01: an outdated notice asks for the choice again', async () => {
    features(true);
    postMock.mockRejectedValue(new ApiError(409, { code: 'DRIVER_AI_NOTICE_OUTDATED' }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'supportCases.ai.choiceAi' }));
    fillAndSubmit();
    expect(await screen.findByRole('button', { name: 'supportCases.ai.choiceTeam' })).toBeTruthy();
    expect(screen.queryByLabelText('supportCases.subject')).toBeNull();
  });

  it('TC-AI-DR-UI-01: a notice version this build has no text for is treated as off', async () => {
    features(true, DRIVER_AI_NOTICE_VERSION + 1);
    renderPage();
    await screen.findByLabelText('supportCases.subject');
    expect(screen.queryByRole('button', { name: 'supportCases.ai.choiceAi' })).toBeNull();
    expect(screen.getByLabelText('supportCases.subject')).toBeTruthy();
  });
});
