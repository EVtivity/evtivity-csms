// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Webhook } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError, getApiErrorCode, getApiErrorFieldDetails } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { providerErrorMessage } from './payment-provider-errors';

/** An EVtivity webhook endpoint at the provider, as the settings routes return it. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  /** platform or connect (Stripe), standard (Adyen). */
  scope: string;
  enabledEvents: string[];
  apiVersion: string | null;
  active: boolean;
}

/** The URL the provider posts to: the API URL of this deployment plus the path. */
export function defaultWebhookUrl(path: string): string {
  return `${API_BASE_URL || window.location.origin}${path}`;
}

/**
 * The webhook setup GET route of a provider, scoped to a webhook URL: the
 * answer splits the EVtivity webhooks at that URL from the ones of other
 * deployments sharing the provider account.
 */
export function webhookSetupPath(route: string, url: string): string {
  return `${route}?url=${encodeURIComponent(url)}`;
}

/** How long the URL field must stay unchanged before the webhook list follows it. */
export const WEBHOOK_URL_QUERY_DELAY_MS = 500;

export interface WebhookUrlState {
  /** The URL field's value. */
  url: string;
  setUrl: (url: string) => void;
  /**
   * The last URL of the field the lookup accepts (http or https), debounced:
   * the webhook list is split by it.
   */
  queryUrl: string;
  /** Moves the list to the field's URL now, when it is valid (Create webhook). */
  commitUrl: () => void;
}

/**
 * The URL field of a webhook card and the URL its webhook list is split by.
 * The list follows the field, so webhooks at an edited URL (a tunnel) show as
 * this deployment's: the ones Create webhook would replace. A value the lookup
 * refuses keeps the last accepted URL and its list on screen.
 */
export function useWebhookUrl(path: string): WebhookUrlState {
  const [url, setUrl] = useState(() => defaultWebhookUrl(path));
  const [queryUrl, setQueryUrl] = useState(() => defaultWebhookUrl(path));

  useEffect(() => {
    const next = url.trim();
    if (next === queryUrl || !isValidWebhookLookupUrl(next, path)) return;
    const timer = setTimeout(() => {
      setQueryUrl(next);
    }, WEBHOOK_URL_QUERY_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [url, queryUrl, path]);

  function commitUrl(): void {
    const next = url.trim();
    if (isValidWebhookLookupUrl(next, path)) setQueryUrl(next);
  }

  return { url, setUrl, queryUrl, commitUrl };
}

function checkWebhookUrl(raw: string, path: string, allowHttp: boolean): boolean {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const protocolOk = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  return (
    protocolOk &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === path &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

/**
 * Same rule as the API registration: https, the exact path, no credentials,
 * query or fragment.
 */
export function isValidWebhookUrl(raw: string, path: string): boolean {
  return checkWebhookUrl(raw, path, false);
}

/**
 * Same rule as the API lookup (the `url` query of the webhook setup GET):
 * http is accepted too, so a local or plain-HTTP deployment lists its webhooks.
 */
export function isValidWebhookLookupUrl(raw: string, path: string): boolean {
  return checkWebhookUrl(raw, path, true);
}

const SCOPES = ['platform', 'connect', 'standard'] as const;
type KnownScope = (typeof SCOPES)[number];

function isKnownScope(scope: string): scope is KnownScope {
  return (SCOPES as readonly string[]).includes(scope);
}

export function WebhookEndpointsTable({
  endpoints,
  emptyText,
}: {
  endpoints: WebhookEndpoint[];
  emptyText: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (endpoints.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('settings.webhookScope')}</TableHead>
            <TableHead>{t('settings.webhookUrlColumn')}</TableHead>
            <TableHead>{t('settings.webhookEvents')}</TableHead>
            <TableHead>{t('settings.webhookApiVersion')}</TableHead>
            <TableHead>{t('settings.webhookState')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.map((endpoint) => (
            <TableRow key={endpoint.id}>
              <TableCell>
                {isKnownScope(endpoint.scope)
                  ? t(`settings.webhookScopes.${endpoint.scope}`)
                  : endpoint.scope}
              </TableCell>
              <TableCell className="break-all font-mono text-xs">{endpoint.url}</TableCell>
              <TableCell className="font-mono text-xs">
                {endpoint.enabledEvents.join(', ')}
              </TableCell>
              <TableCell className="font-mono text-xs">{endpoint.apiVersion ?? '-'}</TableCell>
              <TableCell>
                <Badge variant={endpoint.active ? 'success' : 'outline'}>
                  {endpoint.active ? t('settings.webhookEnabled') : t('settings.webhookDisabled')}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * EVtivity webhooks of other deployments sharing the provider account. The
 * API never changes them; the operator deletes an unused one at the provider.
 */
export function OtherWebhookEndpoints({
  endpoints,
}: {
  endpoints: WebhookEndpoint[] | undefined;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (endpoints == null || endpoints.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="other-webhook-endpoints">
      <h4 className="text-sm font-medium">{t('settings.webhookOtherEndpoints')}</h4>
      <p className="text-xs text-muted-foreground">{t('settings.webhookOtherEndpointsHint')}</p>
      <WebhookEndpointsTable endpoints={endpoints} emptyText="" />
    </div>
  );
}

interface PaymentWebhookSetupProps<T> {
  idPrefix: string;
  /** The URL field, shared with the card's webhook list (useWebhookUrl). */
  urlState: WebhookUrlState;
  /** Path the URL must end in, for example /v1/webhooks/payments/stripe. */
  path: string;
  urlLabel: string;
  urlHint: string;
  createLabel: string;
  replaceTitle: string;
  replaceBody: string;
  replaceConfirmLabel: string;
  canWrite: boolean;
  create: (body: { url: string; replace: boolean }) => Promise<T>;
  onCreated: (result: T) => void;
}

/**
 * The editable webhook URL and the Create webhook button (plan P3.5 O1 a).
 * When webhooks already exist at the URL the API answers 409
 * PAYMENT_WEBHOOK_EXISTS with them; the operator confirms the replacement and
 * the call is repeated with replace: true. Webhooks of other EVtivity
 * deployments at other URLs are never replaced. The card's webhook list is
 * split by the same URL, so the dialog and the list name the same webhooks.
 */
export function PaymentWebhookSetup<T>({
  idPrefix,
  urlState,
  path,
  urlLabel,
  urlHint,
  createLabel,
  replaceTitle,
  replaceBody,
  replaceConfirmLabel,
  canWrite,
  create,
  onCreated,
}: PaymentWebhookSetupProps<T>): React.JSX.Element {
  const { t } = useTranslation();
  const { url, setUrl, commitUrl } = urlState;
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [serverUrlInvalid, setServerUrlInvalid] = useState(false);
  const [existing, setExisting] = useState<WebhookEndpoint[] | null>(null);

  const mutation = useMutation({
    mutationFn: (replace: boolean) => create({ url: url.trim(), replace }),
    onSuccess: (result) => {
      setExisting(null);
      onCreated(result);
    },
    onError: (err) => {
      if (getApiErrorCode(err) === 'PAYMENT_WEBHOOK_EXISTS' && err instanceof ApiError) {
        const body = err.body as { endpoints?: WebhookEndpoint[] } | null;
        setExisting(body?.endpoints ?? []);
        return;
      }
      setExisting(null);
      if (getApiErrorFieldDetails(err)['url'] != null) setServerUrlInvalid(true);
    },
  });

  const urlInvalid = !isValidWebhookUrl(url, path);
  const showUrlError = (hasSubmitted && urlInvalid) || serverUrlInvalid;
  const conflict = getApiErrorCode(mutation.error) === 'PAYMENT_WEBHOOK_EXISTS';

  function handleCreate(): void {
    setHasSubmitted(true);
    if (urlInvalid) return;
    commitUrl();
    mutation.mutate(false);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-webhook-url`} className="leading-6">
          {urlLabel}
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={`${idPrefix}-webhook-url`}
            value={url}
            readOnly={!canWrite}
            onChange={(e) => {
              setUrl(e.target.value);
              setServerUrlInvalid(false);
              mutation.reset();
            }}
            className={showUrlError ? 'border-destructive' : ''}
          />
          {canWrite && (
            <Button
              type="button"
              className="relative shrink-0"
              disabled={mutation.isPending}
              onClick={handleCreate}
            >
              {mutation.isPending && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                </div>
              )}
              <span className={`flex items-center gap-2 ${mutation.isPending ? 'invisible' : ''}`}>
                <Webhook className="h-4 w-4" />
                {createLabel}
              </span>
            </Button>
          )}
        </div>
        {showUrlError && (
          <p className="text-sm text-destructive">{t('settings.webhookUrlInvalid', { path })}</p>
        )}
        <p className="text-xs text-muted-foreground">{urlHint}</p>
      </div>
      {mutation.isError && !conflict && !serverUrlInvalid && (
        <p className="text-sm text-destructive">{providerErrorMessage(mutation.error, t)}</p>
      )}
      <ConfirmDialog
        open={existing != null}
        onOpenChange={(open) => {
          if (!open) {
            setExisting(null);
            mutation.reset();
          }
        }}
        title={replaceTitle}
        description={replaceBody}
        confirmLabel={replaceConfirmLabel}
        isPending={mutation.isPending}
        onConfirm={() => {
          mutation.mutate(true);
          return false;
        }}
      >
        {existing != null && existing.length > 0 && (
          <ul className="space-y-1 text-sm">
            {existing.map((endpoint) => (
              <li key={endpoint.id} className="break-all font-mono text-xs">
                {endpoint.url}
              </li>
            ))}
          </ul>
        )}
      </ConfirmDialog>
    </div>
  );
}
