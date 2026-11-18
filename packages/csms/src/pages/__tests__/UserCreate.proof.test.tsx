// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// New User with the fresh proof an admin-equivalent user takes (a fleet
// manager holds the API key permissions): every proof kind reaches the create
// body, and a failed create shows the real reason, never the generic text.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { getMock, postMock, startAuthenticationMock, state } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  startAuthenticationMock: vi.fn(),
  state: { proofKinds: ['passkey'] as string[] },
}));

vi.mock('@/lib/auth', () => ({ useHasAllSiteAccess: () => true }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => (key.startsWith('errors.') ? `translated:${key}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly body: unknown,
    ) {
      super(`API error ${String(status)}`);
    }
  }
  return {
    api: { get: getMock, post: postMock, put: vi.fn() },
    ApiError,
    getApiErrorFieldDetails: () => ({}),
  };
});
vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  browserSupportsWebAuthnAutofill: () => Promise.resolve(false),
  startAuthentication: startAuthenticationMock,
}));
vi.mock('@/components/PermissionEditor', () => ({ PermissionEditor: () => null }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { ApiError } from '@/lib/api';
import { UserCreate } from '../UserCreate';

const ROLES = [
  { id: 'rol_admin', name: 'admin' },
  { id: 'rol_fleet', name: 'fleet_manager' },
];
const OPTIONS = { challenge: 'chal-1', allowCredentials: [] };
const CREDENTIAL = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: { clientDataJSON: 'a', authenticatorData: 'b', signature: 'c' },
  clientExtensionResults: {},
};

function renderCreate(entry: string): void {
  getMock.mockImplementation((path: string) => {
    if (path === '/v1/roles') return Promise.resolve(ROLES);
    if (path === '/v1/users/me/mfa') {
      return Promise.resolve({ factorProofKinds: state.proofKinds, mfaMethod: 'email' });
    }
    if (path === '/v1/portal/features') return Promise.resolve({ fleetEnabled: true });
    if (path === '/v1/fleets/flt_7') return Promise.resolve({ id: 'flt_7', name: 'Harbor Vans' });
    if (path.startsWith('/v1/fleets')) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: [{ id: 'sit_1', name: 'Depot' }] });
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <UserCreate />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function fillNames(): void {
  fireEvent.change(screen.getByLabelText('common.email'), { target: { value: 'f@b.example' } });
  fireEvent.change(screen.getByLabelText('users.firstName'), { target: { value: 'F' } });
  fireEvent.change(screen.getByLabelText('users.lastName'), { target: { value: 'M' } });
}

async function verifyPasskey(): Promise<void> {
  fireEvent.click(
    await screen.findByRole('button', { name: 'factorProof.passkeyButton' }, { timeout: 5000 }),
  );
  await screen.findByText('factorProof.passkeyVerified', {}, { timeout: 5000 });
}

function createCalls(): Record<string, unknown>[] {
  return postMock.mock.calls
    .filter((c) => c[0] === '/v1/users')
    .map((c) => c[1] as Record<string, unknown>);
}

/**
 * Clicks Create until the create request goes out: the proof reaches the page
 * from an effect after the field renders, so a click before that only marks
 * the form submitted.
 */
async function submitCreate(): Promise<void> {
  await waitFor(
    () => {
      if (createCalls().length === 0 && postMock.mock.calls.every((c) => c[0] !== '/v1/users')) {
        fireEvent.click(screen.getByRole('button', { name: 'common.create' }));
      }
      expect(createCalls()).toHaveLength(1);
    },
    { timeout: 5000 },
  );
}

/** The factor proof route answers the passkey options, the create the given result. */
function answerPosts(create: () => Promise<unknown>): void {
  postMock.mockImplementation((path: string, body: { kind?: string }) => {
    if (path === '/v1/users/me/mfa/factor-proof') {
      return Promise.resolve(body.kind === 'passkey' ? { options: OPTIONS } : { challengeId: 4 });
    }
    if (path === '/v1/users') return create();
    return Promise.resolve({});
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  startAuthenticationMock.mockResolvedValue(CREDENTIAL);
  state.proofKinds = ['passkey'];
});

afterEach(() => {
  cleanup();
  getMock.mockReset();
  postMock.mockReset();
  startAuthenticationMock.mockReset();
});

describe('UserCreate proof', () => {
  it('creates a fleet manager with a passkey proof', async () => {
    answerPosts(() => Promise.resolve({ id: 'usr_9' }));
    renderCreate('/users/new?role=fleet_manager&fleetId=flt_7');
    await screen.findByText('Harbor Vans', {}, { timeout: 5000 });
    fillNames();
    await verifyPasskey();
    await submitCreate();
    expect(createCalls()[0]).toMatchObject({
      roleId: 'rol_fleet',
      accessScope: 'fleets',
      fleetIds: ['flt_7'],
      proof: { kind: 'passkey', credential: CREDENTIAL },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('creates an admin with a passkey proof', async () => {
    answerPosts(() => Promise.resolve({ id: 'usr_8' }));
    renderCreate('/users/new?role=admin');
    fillNames();
    fireEvent.change(screen.getByLabelText('users.access.label'), { target: { value: 'all' } });
    await verifyPasskey();
    await submitCreate();
    expect(createCalls()[0]).toMatchObject({
      roleId: 'rol_admin',
      proof: { kind: 'passkey', credential: CREDENTIAL },
    });
  });

  it.each([
    {
      kind: 'totp',
      fill: () => {
        fireEvent.change(screen.getByLabelText('factorProof.totpLabel'), {
          target: { value: '123456' },
        });
      },
      proof: { kind: 'totp', code: '123456' },
    },
    {
      kind: 'password',
      fill: () => {
        fireEvent.change(screen.getByLabelText('profile.currentPassword'), {
          target: { value: 'pw-1' },
        });
      },
      proof: { kind: 'password', password: 'pw-1' },
    },
    {
      kind: 'code',
      fill: async () => {
        await screen.findByText('factorProof.codeSentEmail');
        fireEvent.change(screen.getByLabelText('factorProof.codeLabel'), {
          target: { value: '654321' },
        });
      },
      proof: { kind: 'code', code: '654321', challengeId: 4 },
    },
  ])('creates a fleet manager with a $kind proof', async ({ kind, fill, proof }) => {
    state.proofKinds = [kind];
    answerPosts(() => Promise.resolve({ id: 'usr_9' }));
    renderCreate('/users/new?role=fleet_manager&fleetId=flt_7');
    await screen.findByText('Harbor Vans', {}, { timeout: 5000 });
    fillNames();
    await fill();
    await submitCreate();
    expect(createCalls()[0]).toMatchObject({ proof });
  });

  it('shows the refusal the API sent and asks for the passkey again', async () => {
    answerPosts(() =>
      Promise.reject(
        new ApiError(400, {
          error: 'The passkey request expired or was already used',
          code: 'WEBAUTHN_CHALLENGE_EXPIRED',
        }),
      ),
    );
    renderCreate('/users/new?role=fleet_manager&fleetId=flt_7');
    await screen.findByText('Harbor Vans', {}, { timeout: 5000 });
    fillNames();
    await verifyPasskey();
    await submitCreate();

    expect(await screen.findByText('translated:errors.WEBAUTHN_CHALLENGE_EXPIRED')).toBeTruthy();
    expect(screen.queryByText('translated:errors.unknown')).toBeNull();
    // The used passkey response is dropped: the next try verifies again.
    expect(await screen.findByRole('button', { name: 'factorProof.passkeyButton' })).toBeTruthy();
  });

  it('says the server could not be reached when the create never got an answer', async () => {
    answerPosts(() => Promise.reject(new TypeError('Failed to fetch')));
    renderCreate('/users/new?role=fleet_manager&fleetId=flt_7');
    await screen.findByText('Harbor Vans', {}, { timeout: 5000 });
    fillNames();
    await verifyPasskey();
    await submitCreate();

    expect(await screen.findByText('translated:errors.networkError')).toBeTruthy();
    expect(screen.queryByText('translated:errors.unknown')).toBeNull();
  });
});
