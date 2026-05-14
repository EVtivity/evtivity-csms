// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'EVtivity CSMS API',
        version: '2.0.0',
        description: [
          'Charging Station Management System REST API.',
          '',
          '## Rate limits',
          'Selected endpoints (auth, password reset, guest checkout, AI assistant, status-check) are rate limited per IP. When a request is throttled the response is `429 RATE_LIMITED`. All responses (including 200s) on rate-limited endpoints include these headers:',
          '- `x-ratelimit-limit` - maximum requests allowed in the current window',
          '- `x-ratelimit-remaining` - requests remaining in the current window',
          '- `x-ratelimit-reset` - seconds until the window resets',
          '',
          '## Error responses',
          'Every error response is JSON with shape `{ error: string, code: string }` where `code` is a stable UPPER_SNAKE_CASE identifier. See the [error code catalog](https://evtivity.com/api-reference/error-codes) for the full list of codes, their HTTP statuses, and localized messages.',
          '',
          '## Authentication',
          'Operator endpoints accept JWT via `Authorization: Bearer <token>` header or the `csms_token` cookie. API keys (64-char hex) are passed via the same Bearer header. Driver portal endpoints use a separate driver JWT via `Authorization: Bearer <token>` or the `portal_token` cookie.',
          '',
          '## Pagination',
          'List endpoints accept `page` (1-based, default 1) and `limit` (default 20, max 100) query parameters and return `{ data: T[], total: number }`.',
        ].join('\n'),
      },
      servers: [
        {
          url: 'https://api.{tenantId}.evtivity.com',
          description: 'Production CSMS API. Replace {tenantId} with your tenant identifier.',
          variables: {
            tenantId: {
              default: 'your-tenant',
              description:
                'Your tenant identifier. Each operator gets a unique subdomain (e.g. acme, demo, fleetops).',
            },
          },
        },
        {
          url: 'http://localhost:3001',
          description: 'Local development (docker compose default)',
        },
      ],
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'Sites', description: 'Site management' },
        { name: 'Stations', description: 'Charging station management' },
        { name: 'Sessions', description: 'Charging session management' },
        { name: 'Drivers', description: 'Driver management' },
        { name: 'Users', description: 'Operator user management' },
        { name: 'Tokens', description: 'RFID and driver token management' },
        { name: 'Dashboard', description: 'Dashboard metrics and analytics' },
        { name: 'Reports', description: 'Scheduled and on-demand reports' },
        { name: 'Access Logs', description: 'Station access log tracking' },
        { name: 'Payments', description: 'Payment processing and refunds' },
        { name: 'Pricing', description: 'Tariff and pricing management' },
        { name: 'Fleets', description: 'Fleet management' },
        { name: 'Notifications', description: 'Notification settings and history' },
        { name: 'Invoices', description: 'Invoice management' },
        { name: 'Reservations', description: 'Charging reservation management' },
        { name: 'Support Cases', description: 'Support case management' },
        { name: 'Transactions', description: 'Transaction history' },
        { name: 'Display Messages', description: 'Station display message management' },
        { name: 'Settings', description: 'System settings' },
        { name: 'OCPP', description: 'OCPP command dispatch and schema retrieval' },
        { name: 'OCPP 2.1 Commands', description: 'OCPP 2.1 CSMS-initiated station commands' },
        { name: 'OCPP 1.6 Commands', description: 'OCPP 1.6 CSMS-initiated station commands' },
        { name: 'Load Management', description: 'Load management and smart charging' },
        { name: 'Events', description: 'Server-sent event stream' },
        { name: 'Webhooks', description: 'Webhook integrations' },
        { name: 'OCPI', description: 'OCPI roaming partner management' },
        { name: 'PnC', description: 'Plug and Charge certificate management' },
        { name: 'Local Auth List', description: 'Station local authorization list management' },
        {
          name: 'Fleet Operations',
          description:
            'Bulk operations across multiple stations (firmware campaigns, configuration templates, smart charging profiles)',
        },
        {
          name: 'Smart Charging',
          description: 'OCPP charging profiles, EV charging needs, and variable monitoring rules',
        },
        {
          name: 'Event Alert Rules',
          description: 'Station event alert rule configuration',
        },
        { name: 'Portal Events', description: 'Driver portal server-sent events' },
        {
          name: 'CSS Actions',
          description: 'Simulator actions that work on all OCPP versions',
        },
        {
          name: 'CSS OCPP 2.1 Actions',
          description: 'Simulator actions for OCPP 2.1 stations',
        },
        {
          name: 'CSS OCPP 1.6 Actions',
          description: 'Simulator actions for OCPP 1.6 stations',
        },
        { name: 'NEVI', description: 'NEVI compliance reporting' },
        { name: 'Portal Auth', description: 'Driver portal authentication' },
        { name: 'Portal Chargers', description: 'Driver portal charger search and sessions' },
        { name: 'Portal Driver', description: 'Driver portal profile management' },
        { name: 'Portal Sessions', description: 'Driver portal session history' },
        { name: 'Portal Payments', description: 'Driver portal payment methods' },
        { name: 'Portal Guest', description: 'Guest checkout flow' },
        { name: 'Portal Support', description: 'Driver portal support cases' },
        { name: 'Portal Roaming', description: 'Driver portal roaming charger search' },
        { name: 'Portal Vehicles', description: 'Driver portal vehicle management' },
        { name: 'Portal Tokens', description: 'Driver portal RFID token management' },
        { name: 'Portal Notifications', description: 'Driver portal notification history' },
        { name: 'Portal Access Logs', description: 'Driver portal access logs' },
        { name: 'API Keys', description: 'API key management' },
        { name: 'AI Assistant', description: 'AI-powered operator assistant' },
        { name: 'CSS Management', description: 'Charging station simulator management' },
        { name: 'OCTT', description: 'OCPP conformance test runner' },
        {
          name: 'Audit',
          description:
            'Per-entity and cross-entity audit logs of every operator-initiated mutation',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });
}
