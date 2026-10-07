// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { X509Certificate } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pkiCaCertificates } from '@evtivity/database';
import {
  createLogger,
  PNC_COMMANDS_CHANNEL,
  PNC_COMMAND_RESULTS_CHANNEL,
  tryParseJson,
} from '@evtivity/lib';
import type { PncCommand, PncCommandResult, PubSubClient, Subscription } from '@evtivity/lib';
import { getPkiProvider } from './provider-factory.js';
import { HubjectProvider } from './hubject-provider.js';

const logger = createLogger('pki-root-refresh');

/** Contract certificate chains end at a V2G root (ISO 15118-2 PKI). */
const ROOT_CERTIFICATE_TYPE = 'V2GRootCertificate';

/** Serializes refreshes across OCPP pods: every pod receives the command. */
const REFRESH_LOCK_KEY = 'pki_root_certificate_refresh';

export interface RootRefreshResult {
  /** Certificates the provider returned. */
  fetched: number;
  /** Root certificates not stored before. */
  added: number;
}

function parseCertificate(pem: string): X509Certificate | null {
  try {
    return new X509Certificate(pem);
  } catch {
    // fail-open: callers skip a certificate that does not parse
    return null;
  }
}

/** A root certificate is self-issued and self-signed; intermediates are skipped. */
function isRootCertificate(cert: X509Certificate): boolean {
  return cert.checkIssued(cert) && cert.verify(cert.publicKey);
}

function toDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Fetches the root certificates from the configured PKI provider and stores
 * the ones `pki_ca_certificates` does not hold yet for that type, in any
 * status, so a root the operator revoked or deleted-and-re-added is never
 * reactivated here. Provider errors propagate.
 */
export async function refreshRootCertificates(): Promise<RootRefreshResult> {
  const provider = await getPkiProvider();
  const pems = await provider.getRootCertificates(ROOT_CERTIFICATE_TYPE);
  const source = provider instanceof HubjectProvider ? 'hubject' : 'manual_upload';

  const roots: Array<{ pem: string; cert: X509Certificate }> = [];
  for (const pem of pems) {
    const cert = parseCertificate(pem);
    if (cert == null) {
      logger.warn('PKI provider returned a certificate that is not valid PEM; skipped');
      continue;
    }
    if (!isRootCertificate(cert)) {
      logger.info({ subject: cert.subject }, 'Skipped a non-root CA certificate');
      continue;
    }
    roots.push({ pem, cert });
  }

  const added = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${REFRESH_LOCK_KEY}))`);
    const existing = await tx
      .select({ certificate: pkiCaCertificates.certificate })
      .from(pkiCaCertificates)
      .where(eq(pkiCaCertificates.certificateType, ROOT_CERTIFICATE_TYPE));
    const known = new Set<string>();
    for (const row of existing) {
      const cert = parseCertificate(row.certificate);
      if (cert != null) known.add(cert.fingerprint256);
    }

    let inserted = 0;
    for (const { pem, cert } of roots) {
      if (known.has(cert.fingerprint256)) continue;
      known.add(cert.fingerprint256);
      await tx.insert(pkiCaCertificates).values({
        certificateType: ROOT_CERTIFICATE_TYPE,
        certificate: pem,
        source,
        serialNumber: cert.serialNumber,
        issuer: cert.issuer,
        subject: cert.subject,
        validFrom: toDate(cert.validFrom),
        validTo: toDate(cert.validTo),
      });
      inserted++;
    }
    return inserted;
  });

  logger.info({ fetched: pems.length, added, source }, 'Root certificates refreshed');
  return { fetched: pems.length, added };
}

async function handlePncCommand(pubsub: PubSubClient, raw: string): Promise<void> {
  // Parsed loosely: the payload comes from another process.
  const parsed = tryParseJson(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn('Bad pnc_commands payload');
    return;
  }
  const command = parsed as { commandId?: unknown; action?: unknown };
  if (typeof command.commandId !== 'string' || command.commandId === '') {
    logger.warn({ action: command.action }, 'pnc_commands payload without a commandId');
    return;
  }

  let result: PncCommandResult;
  if (command.action !== ('refreshRootCertificates' satisfies PncCommand['action'])) {
    result = {
      commandId: command.commandId,
      error: `Unknown PnC action: ${String(command.action)}`,
    };
  } else {
    try {
      result = { commandId: command.commandId, ...(await refreshRootCertificates()) };
    } catch (err: unknown) {
      logger.error({ err }, 'Root certificate refresh failed');
      result = {
        commandId: command.commandId,
        error: err instanceof Error ? err.message : 'Root certificate refresh failed',
      };
    }
  }

  try {
    await pubsub.publish(PNC_COMMAND_RESULTS_CHANNEL, JSON.stringify(result));
  } catch (err: unknown) {
    logger.warn({ err, commandId: command.commandId }, 'pnc_command_results publish failed');
  }
}

/** Handles the API's Plug & Charge commands (`pnc_commands`) in this OCPP process. */
export async function subscribePncCommands(pubsub: PubSubClient): Promise<Subscription> {
  return pubsub.subscribe(PNC_COMMANDS_CHANNEL, (raw: string) => {
    void handlePncCommand(pubsub, raw);
  });
}
