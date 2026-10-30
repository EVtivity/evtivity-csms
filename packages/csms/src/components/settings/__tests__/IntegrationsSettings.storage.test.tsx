// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));
// Imported by the other integration tabs; only the storage tab renders here.
vi.mock('@/lib/auth', () => ({
  useHasPermission: () => true,
  useHasAllSiteAccess: () => true,
  useHasCompanyWidePermission: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});

// The proof field has its own tests: here it hands back a password proof.
vi.mock('@/components/FactorProofField', () => ({
  FactorProofField: ({
    onChange,
    showMissing,
  }: {
    onChange: (proof: { kind: string; password: string }) => void;
    showMissing: boolean;
  }) => (
    <button
      type="button"
      data-testid="s3-proof"
      data-missing={String(showMissing)}
      onClick={() => {
        onChange({ kind: 'password', password: 'pw' });
      }}
    >
      proof
    </button>
  ),
  proofRejection: () => ({ code: null }),
}));

import { ApiError } from '@/lib/api';
import { IntegrationsSettings } from '../IntegrationsSettings';

const AWS_SETTINGS = {
  's3.bucket': 'my-bucket',
  's3.region': 'us-east-1',
  's3.accessKeyIdEnc': 'AKIA123',
  's3.secretAccessKeyEnc': 'secret123',
};

function renderStorageTab(settings: Record<string, unknown>): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/settings?sub=s3']}>
      <QueryClientProvider client={client}>
        <IntegrationsSettings settings={settings} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function valueOf(label: string): string {
  return screen.getByLabelText<HTMLInputElement | HTMLSelectElement>(label).value;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /save/i });
}

function save(): void {
  fireEvent.click(saveButton());
}

/** GET /v1/users/me/mfa answers these proof kinds; other GETs answer {}. */
function proofKinds(kinds: string[]): void {
  apiMock.get.mockImplementation((url: string) =>
    Promise.resolve(url === '/v1/users/me/mfa' ? { factorProofKinds: kinds, mfaMethod: null } : {}),
  );
}

beforeEach(() => {
  proofKinds([]);
  apiMock.put.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IntegrationsSettings storage tab', () => {
  it('saves AWS S3 without endpoint settings', async () => {
    renderStorageTab(AWS_SETTINGS);
    expect(valueOf('settings.s3Provider')).toBe('s3');
    expect(screen.queryByLabelText('settings.s3Endpoint')).toBeNull();
    expect(screen.queryByLabelText('settings.s3AllowedPrivateHosts')).toBeNull();

    save();
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret123',
      });
    });
  });

  it('loads and saves an S3-compatible endpoint with its private hosts', async () => {
    renderStorageTab({
      ...AWS_SETTINGS,
      's3.provider': 's3-compatible',
      's3.endpoint': 'http://minio.internal:9000',
      's3.forcePathStyle': true,
      's3.allowedPrivateHosts': ['minio.internal'],
    });
    expect(valueOf('settings.s3Provider')).toBe('s3-compatible');
    expect(valueOf('settings.s3Endpoint')).toBe('http://minio.internal:9000');
    expect(screen.getByLabelText<HTMLInputElement>('settings.s3ForcePathStyle').checked).toBe(true);
    screen.getByText('settings.s3ImageOriginHint');

    fireEvent.change(screen.getByLabelText('settings.s3AllowedPrivateHosts'), {
      target: { value: 'minio.internal\n 10.0.0.5 \n' },
    });
    save();
    await waitFor(() => {
      expect(apiMock.put).toHaveBeenCalledWith('/v1/settings/s3', {
        provider: 's3-compatible',
        bucket: 'my-bucket',
        region: 'us-east-1',
        accessKeyId: 'AKIA123',
        secretAccessKey: 'secret123',
        endpoint: 'http://minio.internal:9000',
        forcePathStyle: true,
        allowedPrivateHosts: ['minio.internal', '10.0.0.5'],
      });
    });
  });

  it('needs an endpoint before an S3-compatible provider can be saved', () => {
    renderStorageTab(AWS_SETTINGS);
    fireEvent.change(screen.getByLabelText('settings.s3Provider'), {
      target: { value: 's3-compatible' },
    });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('settings.s3Endpoint'), {
      target: { value: 'https://s3.example.com' },
    });
    expect(saveButton().disabled).toBe(false);
  });

  it('says why a refused endpoint was not saved', async () => {
    apiMock.put.mockRejectedValue(new ApiError(400, { error: 'refused', code: 'PRIVATE_URL' }));
    renderStorageTab({
      ...AWS_SETTINGS,
      's3.provider': 's3-compatible',
      's3.endpoint': 'https://10.0.0.5',
    });
    save();
    await screen.findByText('settings.s3EndpointRefused');
  });

  it('says why refused private hosts were not saved', async () => {
    apiMock.put.mockRejectedValue(
      new ApiError(400, {
        error: 'refused',
        code: 'VALIDATION_ERROR',
        field: 'allowedPrivateHosts',
      }),
    );
    renderStorageTab({
      ...AWS_SETTINGS,
      's3.provider': 's3-compatible',
      's3.endpoint': 'http://minio.internal:9000',
    });
    save();
    await screen.findByText('settings.s3AllowedHostsRefused');
  });

  it('says the https rule and the metadata refusal in the private hosts hint', () => {
    renderStorageTab({ ...AWS_SETTINGS, 's3.provider': 's3-compatible' });
    screen.getByText('settings.s3AllowedPrivateHostsHint');
  });

  describe('fresh proof for the provider and endpoint', () => {
    beforeEach(() => {
      proofKinds(['password']);
    });

    it('asks for the proof when the provider changes and sends it', async () => {
      renderStorageTab(AWS_SETTINGS);
      fireEvent.change(screen.getByLabelText('settings.s3Provider'), {
        target: { value: 's3-compatible' },
      });
      fireEvent.change(screen.getByLabelText('settings.s3Endpoint'), {
        target: { value: 'https://s3.wasabisys.com' },
      });
      const proof = await screen.findByTestId('s3-proof');
      save();
      expect(apiMock.put).not.toHaveBeenCalled();
      expect(proof.getAttribute('data-missing')).toBe('true');

      fireEvent.click(proof);
      save();
      await waitFor(() => {
        expect(apiMock.put).toHaveBeenCalledWith(
          '/v1/settings/s3',
          expect.objectContaining({
            provider: 's3-compatible',
            endpoint: 'https://s3.wasabisys.com',
            proof: { kind: 'password', password: 'pw' },
          }),
        );
      });
    });

    it('asks for the proof when only the endpoint changes', async () => {
      renderStorageTab({
        ...AWS_SETTINGS,
        's3.provider': 's3-compatible',
        's3.endpoint': 'https://s3.wasabisys.com',
      });
      expect(screen.queryByTestId('s3-proof')).toBeNull();
      fireEvent.change(screen.getByLabelText('settings.s3Endpoint'), {
        target: { value: 'https://s3.eu-central-1.wasabisys.com' },
      });
      await screen.findByTestId('s3-proof');
    });

    it('sends no proof when the provider and endpoint stay, a trailing slash included', async () => {
      renderStorageTab({
        ...AWS_SETTINGS,
        's3.provider': 's3-compatible',
        's3.endpoint': 'https://s3.wasabisys.com',
      });
      fireEvent.change(screen.getByLabelText('settings.s3Endpoint'), {
        target: { value: 'https://s3.wasabisys.com/' },
      });
      fireEvent.change(screen.getByLabelText('settings.s3Bucket'), {
        target: { value: 'other-bucket' },
      });
      expect(screen.queryByTestId('s3-proof')).toBeNull();
      save();
      await waitFor(() => {
        expect(apiMock.put).toHaveBeenCalledTimes(1);
      });
      const [, body] = apiMock.put.mock.calls[0] as [string, Record<string, unknown>];
      expect(body).not.toHaveProperty('proof');
      expect(body['bucket']).toBe('other-bucket');
    });
  });

  it('shows the generic message for other save errors', async () => {
    apiMock.put.mockRejectedValue(new ApiError(500, { error: 'boom', code: 'INTERNAL' }));
    renderStorageTab(AWS_SETTINGS);
    save();
    await screen.findByText('settings.s3SaveFailed');
  });
});
