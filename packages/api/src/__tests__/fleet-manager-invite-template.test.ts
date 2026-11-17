// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  compileAllowedTemplate,
  EMAIL_BODY_TEMPLATE,
  securityTemplateRenderProblem,
} from '@evtivity/lib';

const here = dirname(fileURLToPath(import.meta.url));
const LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'];
const setPasswordUrl = `https://csms.example.com/reset-password?token=${'a'.repeat(64)}`;

function shipped(lang: string, file: string): string {
  return readFileSync(
    resolve(here, '..', 'templates', lang, 'operator', 'FleetManagerInvite', file),
    'utf-8',
  );
}

describe('fleet manager invitation template', () => {
  it.each(LANGUAGES)('%s: names the fleets and links the setup, never a guide', (lang) => {
    const source = shipped(lang, 'email.hbs');
    const variables = {
      firstName: 'Nora',
      companyName: 'Volt Co',
      fleetNames: 'City Buses, Depot Vans',
      fleetCount: 2,
      setPasswordUrl,
    };
    const html = compileAllowedTemplate(source, EMAIL_BODY_TEMPLATE)(variables);
    expect(html).toContain('City Buses, Depot Vans');
    expect(source).not.toContain('guideUrl');
    expect(html).not.toContain('fleet-manager-setup');
    expect(html).toContain('reset-password?token');
    // The rendered message passes the dispatch rule of security templates.
    expect(
      securityTemplateRenderProblem({
        eventType: 'operator.FleetManagerInvite',
        channel: 'email',
        subject: null,
        body: html,
        shippedBody: source,
        variables,
      }),
    ).toBeNull();
  });

  it('reads without the fleet names when the user has none yet', () => {
    const html = compileAllowedTemplate(
      shipped('en', 'email.hbs'),
      EMAIL_BODY_TEMPLATE,
    )({
      setPasswordUrl,
    });
    expect(html).toContain('has invited you to manage fleets.');
    expect(html).not.toContain('these fleets');
  });
});
