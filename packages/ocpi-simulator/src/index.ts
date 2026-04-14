// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { buildSimApp } from './app.js';
import { state } from './state.js';
import { ocpiGet, ocpiPost } from './client.js';
import { startAutoSessionLoop, stopAutoSessionLoop } from './auto-session.js';

const PORT = Number(process.env['OCPI_SIM_PORT'] ?? 3003);
const HOST = process.env['OCPI_SIM_HOST'] ?? '0.0.0.0';

interface VersionInfo {
  version: string;
  url: string;
}

interface EndpointInfo {
  identifier: string;
  role: 'SENDER' | 'RECEIVER';
  url: string;
}

interface VersionDetail {
  version: string;
  endpoints: EndpointInfo[];
}

async function register(targetVersionsUrl: string, registrationToken: string): Promise<void> {
  const app = { log: console } as unknown as {
    log: { info: typeof console.info; error: typeof console.error };
  };

  app.log.info(`Fetching target versions from ${targetVersionsUrl}`);

  const versions = await ocpiGet<VersionInfo[]>(targetVersionsUrl, registrationToken);

  const preferred = versions.find((v) => v.version === '2.2.1') ?? versions[0];
  if (preferred == null) {
    throw new Error('Target returned no OCPI versions');
  }

  app.log.info(`Using OCPI version ${preferred.version}`);

  const detail = await ocpiGet<VersionDetail>(preferred.url, registrationToken);

  // Store partner endpoints for later use by control API
  state.partnerEndpoints = detail.endpoints;

  const credentialsEndpoint = detail.endpoints.find(
    (e) => e.identifier === 'credentials' && e.role === 'RECEIVER',
  );
  if (credentialsEndpoint == null) {
    throw new Error('Target did not advertise a credentials endpoint');
  }

  // POST our credentials using the one-time registration token
  const ourCredentials = {
    token: state.ourToken,
    url: `${state.baseUrl}/ocpi/versions`,
    roles: [
      {
        role: state.role.toUpperCase(),
        party_id: state.partyId,
        country_code: state.countryCode,
        business_details: { name: state.name },
      },
    ],
  };

  const returned = await ocpiPost<{ token: string }>(
    credentialsEndpoint.url,
    ourCredentials,
    registrationToken,
  );

  state.theirToken = returned.token;
  state.isRegistered = true;

  app.log.info(
    {
      partneredWith: targetVersionsUrl,
      version: preferred.version,
      endpointCount: detail.endpoints.length,
    },
    'Registered with target OCPI server',
  );
}

async function start(): Promise<void> {
  const app = buildSimApp();

  // Register all routes before listen
  app.post('/sim/register', async (request, reply) => {
    const body = request.body as {
      targetVersionsUrl?: string;
      registrationToken?: string;
    } | null;

    if (
      body == null ||
      typeof body.targetVersionsUrl !== 'string' ||
      typeof body.registrationToken !== 'string'
    ) {
      await reply.status(400).send({
        error: 'Body must include targetVersionsUrl and registrationToken',
      });
      return;
    }

    try {
      await register(body.targetVersionsUrl, body.registrationToken);
      return { registered: true, theirToken: `${state.theirToken?.slice(0, 8) ?? ''}...` };
    } catch (err) {
      await reply.status(500).send({ error: String(err) });
      return;
    }
  });

  await app.listen({ port: PORT, host: HOST });
  app.log.info(
    {
      role: state.role,
      countryCode: state.countryCode,
      partyId: state.partyId,
      port: PORT,
    },
    'OCPI Simulator started',
  );

  const targetUrl = process.env['OCPI_TARGET_URL'];
  const registrationToken = process.env['OCPI_REGISTRATION_TOKEN'];

  if (targetUrl != null && registrationToken != null) {
    const versionsUrl = `${targetUrl}/ocpi/versions`;
    app.log.info(`Auto-registering with ${versionsUrl}`);
    try {
      await register(versionsUrl, registrationToken);
      app.log.info('Registration complete. Simulator is ready.');
      await startAutoSessionLoop();
    } catch (err) {
      app.log.error({ err }, 'Auto-registration failed. Use POST /sim/register to retry.');
    }
  } else {
    app.log.info('No OCPI_TARGET_URL or OCPI_REGISTRATION_TOKEN set. Start in unregistered mode.');
    app.log.info(
      'Use POST /sim/register { targetVersionsUrl, registrationToken } to register manually.',
    );
  }

  const handleSignal = (): void => {
    stopAutoSessionLoop();
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
}

start().catch((err: unknown) => {
  console.error('Failed to start OCPI Simulator:', err);
  process.exit(1);
});
