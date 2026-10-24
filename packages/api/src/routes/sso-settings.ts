// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, like } from 'drizzle-orm';
import {
  db,
  settings,
  roles,
  users,
  userPermissions,
  clearSsoSettingsCache,
  writeAudit,
  settingAuditLog,
} from '@evtivity/database';
import { encryptString, permissionCatalog } from '@evtivity/lib';
import { decryptForRead } from '../lib/settings-crypto.js';
import { zodSchema } from '../lib/zod-schema.js';
import { successResponse, itemResponse, errorWith } from '../lib/response-schemas.js';
import { ERROR_CODES } from '../lib/error-codes.generated.js';
import { authorize } from '../middleware/rbac.js';
import { config as apiConfig } from '../lib/config.js';
import { requireAllSiteAccess } from '../lib/site-access.js';
import { getAuditActor } from '../lib/audit-actor.js';
import { canGrantPermissions } from '../lib/user-management-scope.js';
import { factorProof } from '../lib/mfa-factor-proof.js';
import {
  SESSION_PROOF_ERROR_CODES,
  isApiKeyRequest,
  requireSessionProof,
  sessionProofErrorFields,
} from '../lib/session-proof.js';
import { sendSecurityNotice } from '../lib/security-notice.js';

// SSO decides who signs in as which operator: company-wide, so a
// site-restricted user gets this 404 before any read or write
// (requireAllSiteAccess, features/site-access-control.md).
const ALL_SITES_SETTING_NOT_FOUND = {
  error: 'Setting not found',
  code: 'SETTING_NOT_FOUND',
} as const;

const SSO_KEYS = [
  'sso.enabled',
  'sso.provider',
  'sso.entryPoint',
  'sso.issuer',
  'sso.certEnc',
  'sso.autoProvision',
  'sso.defaultRoleId',
  'sso.attributeMapping',
  'sso.allowedDomains',
];

const ssoSettingsBody = z.object({
  enabled: z.boolean().describe('Enable or disable SSO'),
  provider: z.string().describe('Identity provider hint: okta, azure-ad, google-workspace, custom'),
  entryPoint: z.string().describe('IdP SSO URL (entry point)'),
  issuer: z.string().describe('SP entity ID'),
  cert: z
    .string()
    .optional()
    .describe('IdP X.509 certificate PEM (stored encrypted). Only sent when changed.'),
  autoProvision: z.boolean().describe('Auto-create users from SAML assertions'),
  defaultRoleId: z.string().describe('Role assigned to auto-provisioned users'),
  attributeMapping: z
    .record(z.string(), z.string())
    .describe('Maps IdP SAML attributes to user fields'),
  allowedDomains: z
    .array(z.string().min(1).max(253))
    .max(100)
    .optional()
    .describe(
      'Email domains SSO may sign in or create accounts for (empty: every domain). Omitted keeps the stored list. Recommended: name your company domains.',
    ),
  proof: factorProof
    .optional()
    .describe(
      'Fresh proof of the account, required from a signed-in session (not from an API key) when anything but the provider hint changes: a factor it holds, else its password',
    ),
});

/** The identity provider fields (the notice says whether one changed). */
const IDP_FIELDS = ['sso.entryPoint', 'sso.issuer', 'sso.certEnc'] as const;

/**
 * The identity provider and account mapping fields an API key may never change:
 * which provider signs in, and which of its users maps to which account.
 */
const SESSION_ONLY_FIELDS = [...IDP_FIELDS, 'sso.attributeMapping'] as const;

/** The allowed domains as a sorted lowercase list (empty: every domain). */
function domainList(value: unknown): string[] {
  return JSON.parse(comparable('sso.allowedDomains', value)) as string[];
}

/** Whether new allowed domains let in an email the stored list refused. */
function widensDomains(stored: unknown, next: unknown): boolean {
  const before = domainList(stored);
  if (before.length === 0) return false;
  const after = domainList(next);
  return after.length === 0 || after.some((d) => !before.includes(d));
}

/** The SSO values as stored, the certificate decrypted, to tell what a save changes. */
async function storedSsoValues(): Promise<Map<string, unknown>> {
  const rows = await db.select().from(settings).where(inArray(settings.key, SSO_KEYS));
  return new Map(rows.map((row) => [row.key, decryptForRead(row.key, row.value)]));
}

/** A stored value in the shape the body sends it, for the change comparison. */
function comparable(key: string, value: unknown): string {
  if (key === 'sso.allowedDomains') {
    const list = Array.isArray(value)
      ? value.map(String)
      : typeof value === 'string'
        ? value.split(',')
        : [];
    return JSON.stringify(
      list
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d !== '')
        .sort(),
    );
  }
  if (value == null || value === '') return JSON.stringify(null);
  if (key === 'sso.attributeMapping' && typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * The active users who are told of an SSO change: every all-site user who may
 * change SSO itself (`settings.security:write`).
 */
async function ssoAdminIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userPermissions, eq(userPermissions.userId, users.id))
    .where(
      and(
        eq(users.isActive, true),
        eq(users.hasAllSiteAccess, true),
        eq(userPermissions.permission, 'settings.security:write'),
      ),
    );
  return rows.map((r) => r.id);
}

function getEncryptionKey(): string {
  const key = apiConfig.SETTINGS_ENCRYPTION_KEY;
  if (key === '') {
    throw new Error('SETTINGS_ENCRYPTION_KEY environment variable is required');
  }
  return key;
}

export function ssoSettingsRoutes(app: FastifyInstance): void {
  app.get(
    '/sso/settings',
    {
      onRequest: [authorize('settings.security:read')],
      schema: {
        tags: ['Settings'],
        summary: 'Get SSO (SAML 2.0) settings',
        operationId: 'getSsoSettings',
        security: [{ bearerAuth: [] }],
        response: {
          200: itemResponse(z.record(z.string(), z.unknown())),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const rows = await db.select().from(settings).where(like(settings.key, 'sso.%'));
      const result: Record<string, unknown> = {};
      for (const row of rows) {
        if (!SSO_KEYS.includes(row.key)) continue;
        result[row.key] = decryptForRead(row.key, row.value);
      }
      return result;
    },
  );

  app.put(
    '/sso/settings',
    {
      onRequest: [authorize('settings.security:write')],
      schema: {
        tags: ['Settings'],
        summary: 'Update SSO (SAML 2.0) settings',
        operationId: 'updateSsoSettings',
        security: [{ bearerAuth: [] }],
        body: zodSchema(ssoSettingsBody),
        response: {
          200: successResponse,
          400: errorWith(
            'Unknown default role, or a missing or wrong proof',
            SESSION_PROOF_ERROR_CODES,
            sessionProofErrorFields,
          ),
          403: errorWith(
            'API key changing the identity provider or account mapping, or a role beyond your own',
            [ERROR_CODES.SESSION_REQUIRED, ERROR_CODES.PERMISSIONS_EXCEED_OWN],
          ),
          404: errorWith('Setting not found', [ERROR_CODES.SETTING_NOT_FOUND]),
          500: errorWith('Encryption key missing', [ERROR_CODES.ENCRYPTION_KEY_MISSING]),
        },
      },
    },
    async (request, reply) => {
      if (!(await requireAllSiteAccess(request, reply, ALL_SITES_SETTING_NOT_FOUND))) return;
      const body = request.body as z.infer<typeof ssoSettingsBody>;

      const upsert = (key: string, value: unknown) =>
        db
          .insert(settings)
          .values({ key, value })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() },
          });

      const written: Array<{ key: string; value: unknown }> = [
        { key: 'sso.enabled', value: body.enabled },
        { key: 'sso.provider', value: body.provider },
        { key: 'sso.entryPoint', value: body.entryPoint },
        { key: 'sso.issuer', value: body.issuer },
        { key: 'sso.autoProvision', value: body.autoProvision },
        { key: 'sso.defaultRoleId', value: body.defaultRoleId },
        { key: 'sso.attributeMapping', value: JSON.stringify(body.attributeMapping) },
      ];
      if (body.allowedDomains !== undefined) {
        written.push({
          key: 'sso.allowedDomains',
          value: [
            ...new Set(
              body.allowedDomains.map((d) => d.trim().toLowerCase()).filter((d) => d !== ''),
            ),
          ].sort(),
        });
      }

      const stored = await storedSsoValues();
      const certChanged =
        body.cert !== undefined && body.cert !== '' && body.cert !== stored.get('sso.certEnc');
      const changed = new Set(
        written
          .filter(({ key, value }) => comparable(key, stored.get(key)) !== comparable(key, value))
          .map(({ key }) => key),
      );
      if (certChanged) changed.add('sso.certEnc');

      // An API key must never point SSO at its own identity provider, remap its
      // users onto other accounts, or let in more domains: it could then sign in
      // as any account. Narrowing the domains stays open.
      const allowedDomainsWritten = written.find((w) => w.key === 'sso.allowedDomains');
      if (
        isApiKeyRequest(request) &&
        (SESSION_ONLY_FIELDS.some((key) => changed.has(key)) ||
          (allowedDomainsWritten != null &&
            widensDomains(stored.get('sso.allowedDomains'), allowedDomainsWritten.value)))
      ) {
        await reply.status(403).send({
          error:
            'The identity provider, account mapping and a wider domain list change only from a signed-in session',
          code: 'SESSION_REQUIRED',
        });
        return;
      }

      // Auto-provisioned users get the role's defaults: no one sets a role that
      // grants more than it holds itself (API key scope included).
      if (body.defaultRoleId !== '' && (body.autoProvision || changed.has('sso.defaultRoleId'))) {
        const [role] = await db
          .select({ name: roles.name })
          .from(roles)
          .where(eq(roles.id, body.defaultRoleId));
        if (role == null) {
          await reply
            .status(400)
            .send({ error: 'Default role does not exist', code: 'VALIDATION_ERROR' });
          return;
        }
        if (!(await canGrantPermissions(request, permissionCatalog.defaultsFor(role.name)))) {
          await reply.status(403).send({
            error: 'The default role must not grant more than your own permissions',
            code: 'PERMISSIONS_EXCEED_OWN',
          });
          return;
        }
      }

      // Who signs in as whom: from a session, every change but the provider hint
      // takes a fresh proof. Checked last, so a refused save
      // never uses up a one-time code.
      const protectedChange = [...changed].some((key) => key !== 'sso.provider');
      if (protectedChange && !(await requireSessionProof(request, reply, body.proof))) return;

      if (certChanged && body.cert !== undefined) {
        try {
          const encrypted = encryptString(body.cert, getEncryptionKey());
          written.push({ key: 'sso.certEnc', value: encrypted });
        } catch (err) {
          request.log.error(
            { err, key: 'sso.certEnc' },
            'Encrypting the SSO certificate failed, nothing saved',
          );
          await reply.status(500).send({
            error: 'SETTINGS_ENCRYPTION_KEY not configured on server',
            code: 'ENCRYPTION_KEY_MISSING',
          });
          return;
        }
      }

      await Promise.all(written.map((w) => upsert(w.key, w.value)));
      clearSsoSettingsCache();

      // One setting.updated row per changed key. The certificate counts as changed
      // when it differs from the stored one; its row records only that it is configured.
      const actor = getAuditActor(request);
      await Promise.allSettled(
        written
          .filter(({ key }) => changed.has(key))
          .map(({ key, value }) => {
            const secret = key.endsWith('Enc');
            return writeAudit(
              { table: settingAuditLog, idColumn: 'setting_key' },
              {
                entityId: key,
                entityIdSnapshot: key,
                action: 'updated',
                ...actor,
                before: secret
                  ? { key, configured: stored.has(key) }
                  : { key, value: stored.get(key) ?? null },
                after: secret ? { key, configured: true } : { key, value },
              },
              db,
              request.log,
            );
          }),
      );
      if (changed.size > 0) {
        const idpChanged = IDP_FIELDS.some((key) => changed.has(key));
        // Fail-open: the change stands, a lost notice is logged.
        void ssoAdminIds()
          .then((ids) => {
            for (const userId of ids) {
              sendSecurityNotice(
                { userId },
                'security.SsoSettingsChanged',
                { idpChanged, ssoEnabled: body.enabled, autoProvision: body.autoProvision },
                request.log,
              );
            }
          })
          .catch((err: unknown) => {
            request.log.warn({ err }, 'SSO change notice recipients failed, the change stands');
          });
      }
      return { success: true };
    },
  );
}
