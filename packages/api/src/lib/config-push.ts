// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and } from 'drizzle-orm';
import {
  db,
  configTemplates,
  configTemplatePushes,
  configTemplatePushStations,
  chargingStations,
} from '@evtivity/database';
import { sendOcppCommandAndWait } from './ocpp-command.js';

const CONCURRENCY_LIMIT = 10;

export async function processConfigPush(
  pushId: string,
  stations: { id: string; stationId: string }[],
  variables: { component: string; variable: string; value: string }[],
  ocppVersion: string,
): Promise<void> {
  try {
    // Process stations with concurrency limit
    for (let i = 0; i < stations.length; i += CONCURRENCY_LIMIT) {
      const batch = stations.slice(i, i + CONCURRENCY_LIMIT);
      await Promise.all(
        batch.map(async (station) => {
          try {
            if (ocppVersion === '1.6') {
              // OCPP 1.6: one SetVariables per variable, collect all results
              const errors: string[] = [];
              for (const v of variables) {
                const result = await sendOcppCommandAndWait(
                  station.stationId,
                  'SetVariables',
                  {
                    setVariableData: [
                      {
                        component: { name: v.component },
                        variable: { name: v.variable },
                        attributeValue: v.value,
                      },
                    ],
                  },
                  ocppVersion,
                );

                if (result.error != null) {
                  errors.push(`${v.variable}: ${result.error}`);
                } else if (result.response != null) {
                  const setResult = result.response as {
                    setVariableResult?: Array<{ attributeStatus?: string }>;
                    // OCPP 1.6 mapped response
                    status?: string;
                  };
                  const status =
                    setResult.setVariableResult?.[0]?.attributeStatus ?? setResult.status;
                  if (status !== 'Accepted') {
                    errors.push(`${v.variable}: ${status ?? 'Unknown'}`);
                  }
                }
              }

              if (errors.length > 0) {
                await db
                  .update(configTemplatePushStations)
                  .set({
                    status: 'rejected',
                    errorInfo: errors.join('; '),
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(configTemplatePushStations.pushId, pushId),
                      eq(configTemplatePushStations.stationId, station.id),
                    ),
                  );
              } else {
                await db
                  .update(configTemplatePushStations)
                  .set({ status: 'accepted', updatedAt: new Date() })
                  .where(
                    and(
                      eq(configTemplatePushStations.pushId, pushId),
                      eq(configTemplatePushStations.stationId, station.id),
                    ),
                  );

                // Refresh station configurations after successful 1.6 push
                try {
                  await sendOcppCommandAndWait(
                    station.stationId,
                    'GetConfiguration',
                    {},
                    ocppVersion,
                  );
                } catch {
                  // Non-critical: refresh failure should not mark push as failed
                }
              }
            } else {
              // OCPP 2.1: bulk SetVariables
              const result = await sendOcppCommandAndWait(
                station.stationId,
                'SetVariables',
                {
                  setVariableData: variables.map((v) => ({
                    component: { name: v.component },
                    variable: { name: v.variable },
                    attributeValue: v.value,
                  })),
                },
                ocppVersion,
              );

              if (result.error != null) {
                await db
                  .update(configTemplatePushStations)
                  .set({
                    status: 'failed',
                    errorInfo: result.error,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(configTemplatePushStations.pushId, pushId),
                      eq(configTemplatePushStations.stationId, station.id),
                    ),
                  );
              } else {
                const response = result.response as {
                  setVariableResult?: Array<{
                    attributeStatus?: string;
                    component?: { name?: string };
                    variable?: { name?: string };
                  }>;
                };
                const results = response.setVariableResult ?? [];
                const rejected = results.filter((r) => r.attributeStatus !== 'Accepted');

                if (rejected.length > 0) {
                  const errorDetails = rejected
                    .map(
                      (r) =>
                        `${r.component?.name ?? ''}.${r.variable?.name ?? ''}: ${r.attributeStatus ?? 'Unknown'}`,
                    )
                    .join('; ');
                  await db
                    .update(configTemplatePushStations)
                    .set({
                      status: 'rejected',
                      errorInfo: errorDetails,
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(configTemplatePushStations.pushId, pushId),
                        eq(configTemplatePushStations.stationId, station.id),
                      ),
                    );
                } else {
                  await db
                    .update(configTemplatePushStations)
                    .set({ status: 'accepted', updatedAt: new Date() })
                    .where(
                      and(
                        eq(configTemplatePushStations.pushId, pushId),
                        eq(configTemplatePushStations.stationId, station.id),
                      ),
                    );

                  // Refresh station configurations after successful 2.1 push
                  try {
                    await sendOcppCommandAndWait(
                      station.stationId,
                      'GetBaseReport',
                      {
                        requestId: Math.floor(Math.random() * 2147483647),
                        reportBase: 'FullInventory',
                      },
                      ocppVersion,
                    );
                  } catch {
                    // Non-critical: refresh failure should not mark push as failed
                  }
                }
              }
            }
          } catch {
            await db
              .update(configTemplatePushStations)
              .set({
                status: 'failed',
                errorInfo: 'Internal error',
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(configTemplatePushStations.pushId, pushId),
                  eq(configTemplatePushStations.stationId, station.id),
                ),
              );
          }
        }),
      );
    }

    // Mark push as completed
    await db
      .update(configTemplatePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(configTemplatePushes.id, pushId));
  } catch {
    // If something goes wrong at the batch level, still try to mark as completed
    await db
      .update(configTemplatePushes)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(configTemplatePushes.id, pushId))
      .catch(() => {});
  }
}

export async function pushTemplateToSiteStations(
  templateId: string,
  siteId: string,
): Promise<string> {
  const [template] = await db
    .select()
    .from(configTemplates)
    .where(eq(configTemplates.id, templateId));
  if (template == null) return '';

  const variables = template.variables as Array<{
    component: string;
    variable: string;
    value: string;
  }>;
  if (variables.length === 0) return '';

  const expectedProtocol = `ocpp${template.ocppVersion}`;
  const targetStations = await db
    .select({ id: chargingStations.id, stationId: chargingStations.stationId })
    .from(chargingStations)
    .where(
      and(
        eq(chargingStations.isOnline, true),
        eq(chargingStations.ocppProtocol, expectedProtocol),
        eq(chargingStations.siteId, siteId),
      ),
    );

  if (targetStations.length === 0) return '';

  const [push] = await db
    .insert(configTemplatePushes)
    .values({ templateId, status: 'active', stationCount: targetStations.length })
    .returning();
  const pushId = push?.id ?? '';

  await db
    .insert(configTemplatePushStations)
    .values(targetStations.map((s) => ({ pushId, stationId: s.id, status: 'pending' as const })));

  void processConfigPush(pushId, targetStations, variables, template.ocppVersion);
  return pushId;
}
