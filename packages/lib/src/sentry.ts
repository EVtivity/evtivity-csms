// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as Sentry from '@sentry/node';

let initialized = false;

export interface SentryConfig {
  enabled: boolean;
  dsn: string;
  environment: string;
}

/** A URL without its query string and fragment (tokens and codes stay out of events). */
function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/**
 * Removes what may carry a credential or personal data from an event before
 * it leaves the process: request cookies, headers, body, query string and
 * environment, the query of every URL, and the user's address and email
 * (the user id stays for grouping). A second layer behind `dataCollection`.
 */
export function scrubSentryEvent<E extends Sentry.Event>(event: E): E {
  if (event.request != null) {
    const { url, method } = event.request;
    event.request = {
      ...(url != null ? { url: withoutQuery(url) } : {}),
      ...(method != null ? { method } : {}),
    };
  }
  if (event.user != null) {
    event.user = event.user.id != null ? { id: event.user.id } : {};
  }
  if (event.breadcrumbs != null) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }
  return event;
}

function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const url: unknown = breadcrumb.data?.['url'];
  if (typeof url !== 'string') return breadcrumb;
  return { ...breadcrumb, data: { ...breadcrumb.data, url: withoutQuery(url) } };
}

export function initSentry(serviceName: string, config: SentryConfig): void {
  if (initialized) return;

  if (!config.enabled || config.dsn === '') {
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    serverName: serviceName,
    tracesSampleRate: 0.1,
    // Collect nothing a request or a stack frame can carry: the SDK default
    // sends cookies, headers, bodies, query strings, AI prompts and local
    // variables.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });

  initialized = true;
}
