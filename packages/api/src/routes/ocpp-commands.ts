// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ActionRegistry,
  type ActionName,
  ActionRegistry16,
  type ActionName16,
} from '@evtivity/ocpp';
import type { Subscription } from '@evtivity/lib';
import { eq, and } from 'drizzle-orm';
import { db, chargingStations, stationConfigurations } from '@evtivity/database';
import { zodSchema } from '../lib/zod-schema.js';
import { itemResponse, errorResponse } from '../lib/response-schemas.js';
import { getPubSub } from '../lib/pubsub.js';
import { getUserSiteIds } from '../lib/site-access.js';

// --- v21 type imports ---
import {
  resetEnum as resetEnumV21,
  operationalStatusEnum,
  evseType,
  messageTriggerEnum as messageTriggerEnumV21,
  updateEnum,
  authorizationData,
  chargingProfileType as chargingProfileTypeV21,
  clearChargingProfileType,
  chargingRateUnitEnum as chargingRateUnitEnumV21,
  firmwareType,
  idTokenType,
  certificateSigningUseEnum,
  installCertificateUseEnum,
  certificateHashDataType,
  getCertificateIdUseEnum,
  reportBaseEnum,
  componentVariableType,
  componentCriterionEnum,
  monitoringBaseEnum,
  setMonitoringDataType,
  monitoringCriterionEnum,
  networkConnectionProfileType,
  messageInfoType,
  messagePriorityEnum,
  messageStateEnum,
  tariffType,
  getVariableDataType,
  setVariableDataType,
  logEnum,
  logParametersType,
  derControlEnum,
  derCurveType,
  enterServiceType,
  fixedPFType,
  fixedVarType,
  freqDroopType,
  gradientType,
  limitMaxDischargeType,
  chargingProfileCriterionType,
  chargingScheduleUpdateType,
  constantStreamDataType,
  periodicEventStreamParamsType,
} from '../lib/ocpp-zod-types-v21.js';

// --- v16 type imports ---
import { authorize } from '../middleware/rbac.js';
import {
  resetTypeEnum as resetTypeEnumV16,
  availabilityTypeEnum,
  messageTriggerEnum as messageTriggerEnumV16,
  updateTypeEnum,
  authorizationDataType,
  chargingProfileType as chargingProfileTypeV16,
  chargingProfilePurposeEnum as chargingProfilePurposeEnumV16,
  chargingRateUnitEnum as chargingRateUnitEnumV16,
} from '../lib/ocpp-zod-types-v16.js';

const RESPONSE_TIMEOUT_MS = 35_000;
const RESULTS_CHANNEL = 'ocpp_command_results';

// ---------------------------------------------------------------------------
// Shared response schemas
// ---------------------------------------------------------------------------

const ocppCommandSuccess = z
  .object({
    status: z.string(),
    stationId: z.string(),
    action: z.string(),
    response: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ocppCommandError = z
  .object({
    status: z.string(),
    code: z.string(),
    stationId: z.string(),
    action: z.string(),
    error: z.string(),
  })
  .passthrough();

interface CommandResult {
  commandId: string;
  response?: Record<string, unknown>;
  error?: string;
}

const commandResponses = {
  200: itemResponse(ocppCommandSuccess),
  400: errorResponse,
  404: errorResponse,
  500: itemResponse(ocppCommandError),
  502: itemResponse(ocppCommandError),
  504: itemResponse(ocppCommandError),
};

// ---------------------------------------------------------------------------
// Helper: raw dispatch that returns a result object (no reply coupling)
// ---------------------------------------------------------------------------

interface DispatchResult {
  code: number;
  body: Record<string, unknown>;
}

async function dispatchCommandRaw(
  app: FastifyInstance,
  userId: string,
  stationId: string,
  action: string,
  payload: Record<string, unknown>,
  ocppVersion?: 'ocpp1.6' | 'ocpp2.1',
  options?: { skipValidation?: boolean; skipSiteAccess?: boolean },
): Promise<DispatchResult> {
  const pubsub = getPubSub();

  if (options?.skipValidation !== true) {
    let entry: { validateRequest: (p: unknown) => boolean & { errors?: unknown } } | undefined;
    if (ocppVersion != null) {
      const is16 = ocppVersion === 'ocpp1.6';
      const registry = is16 ? ActionRegistry16 : ActionRegistry;
      entry = registry[action as ActionName & ActionName16] as typeof entry;
    } else {
      entry =
        (ActionRegistry as Record<string, typeof entry>)[action] ??
        (ActionRegistry16 as Record<string, typeof entry>)[action];
    }
    if (entry == null) {
      return { code: 400, body: { error: 'Unknown OCPP action', code: 'UNKNOWN_ACTION', action } };
    }

    const valid = entry.validateRequest(payload);
    if (!valid) {
      return {
        code: 400,
        body: {
          error: 'Invalid OCPP payload',
          code: 'INVALID_PAYLOAD',
          action,
          validationErrors: (entry.validateRequest as { errors?: unknown }).errors,
        },
      };
    }
  }

  if (options?.skipSiteAccess !== true) {
    const siteAccessIds = await getUserSiteIds(userId);
    if (siteAccessIds != null) {
      const [station] = await db
        .select({ siteId: chargingStations.siteId })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));
      if (station == null || station.siteId == null || !siteAccessIds.includes(station.siteId)) {
        return {
          code: 404,
          body: { error: 'Station not found', code: 'STATION_NOT_FOUND' },
        };
      }
    }
  }

  const commandId = crypto.randomUUID();
  app.log.info({ commandId, stationId, action }, 'OCPP command requested');

  let subscription: Subscription | null = null;

  try {
    const result = await new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (subscription != null) {
          void subscription.unsubscribe().catch(() => {});
          subscription = null;
        }
        resolve({ commandId, error: 'No response within 35s' });
      }, RESPONSE_TIMEOUT_MS);

      void pubsub
        .subscribe(RESULTS_CHANNEL, (rawPayload: string) => {
          let parsed: CommandResult;
          try {
            parsed = JSON.parse(rawPayload) as CommandResult;
          } catch {
            return;
          }
          if (parsed.commandId !== commandId) return;

          clearTimeout(timeout);
          if (subscription != null) {
            void subscription.unsubscribe().catch(() => {});
            subscription = null;
          }
          resolve(parsed);
        })
        .then(async (sub) => {
          subscription = sub;

          const notification = JSON.stringify({
            commandId,
            stationId,
            action,
            payload,
            ...(ocppVersion != null && { version: ocppVersion }),
          });

          await pubsub.publish('ocpp_commands', notification);
        })
        .catch((err: unknown) => {
          clearTimeout(timeout);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    if (result.error != null) {
      const isTimeout = result.error.includes('No response within');
      return {
        code: isTimeout ? 504 : 502,
        body: {
          status: isTimeout ? 'timeout' : 'error',
          code: isTimeout ? 'COMMAND_TIMEOUT' : 'COMMAND_ERROR',
          stationId,
          action,
          error: result.error,
        },
      };
    }

    return {
      code: 200,
      body: { status: 'accepted', stationId, action, response: result.response },
    };
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- subscription is set asynchronously in .then()
    if (subscription != null) {
      void (subscription as Subscription).unsubscribe().catch(() => {});
    }
    app.log.error({ commandId, error: err }, 'Command listener error');
    return {
      code: 500,
      body: {
        status: 'error',
        code: 'INTERNAL_ERROR',
        stationId,
        action,
        error: 'Internal server error',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: dispatch a command and wait for a result (sends reply)
// ---------------------------------------------------------------------------

async function dispatchCommand(
  app: FastifyInstance,
  request: { user: unknown },
  reply: {
    status: (code: number) => { send: (body: unknown) => Promise<unknown> };
  },
  stationId: string,
  action: string,
  payload: Record<string, unknown>,
  ocppVersion?: 'ocpp1.6' | 'ocpp2.1',
): Promise<unknown> {
  const { userId } = request.user as { userId: string };
  const result = await dispatchCommandRaw(app, userId, stationId, action, payload, ocppVersion);
  return reply.status(result.code).send(result.body);
}

// ---------------------------------------------------------------------------
// Helper: register a typed command route
// ---------------------------------------------------------------------------

function commandRoute(
  app: FastifyInstance,
  version: 'v21' | 'v16',
  commandName: string,
  ocppVersion: 'ocpp2.1' | 'ocpp1.6',
  summary: string,
  bodySchema: z.ZodType,
): void {
  app.post(
    `/ocpp/commands/${version}/${commandName}`,
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: [`OCPP ${version === 'v21' ? '2.1' : '1.6'} Commands`],
        summary,
        operationId: `ocpp${version}_${commandName}`,
        security: [{ bearerAuth: [] }],
        body: zodSchema(bodySchema),
        response: commandResponses,
      },
    },
    async (request, reply) => {
      const body = request.body as { stationId: string } & Record<string, unknown>;
      const { stationId, ...payload } = body;
      return dispatchCommand(
        app,
        request,
        reply as unknown as {
          status: (code: number) => { send: (body: unknown) => Promise<unknown> };
        },
        stationId,
        commandName,
        payload,
        ocppVersion,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// stationId field (shared across all command bodies)
// ---------------------------------------------------------------------------

const stationIdField = z.string().describe('Target station OCPP ID');

// ===========================================================================
// OCPP 2.1 Command Body Schemas
// ===========================================================================

const resetV21Body = z.object({
  stationId: stationIdField,
  type: resetEnumV21.describe('Reset type'),
  evseId: z.number().int().optional().describe('EVSE ID (omit for whole station)'),
});

const requestStartTransactionV21Body = z.object({
  stationId: stationIdField,
  remoteStartId: z.number().int().describe('Remote start ID'),
  idToken: idTokenType.describe('ID token for authorization'),
  evseId: z.number().int().optional().describe('EVSE ID'),
  groupIdToken: idTokenType.optional().describe('Group ID token'),
  chargingProfile: chargingProfileTypeV21.optional().describe('Charging profile'),
});

const requestStopTransactionV21Body = z.object({
  stationId: stationIdField,
  transactionId: z.string().describe('Transaction ID to stop'),
});

const getTransactionStatusV21Body = z.object({
  stationId: stationIdField,
  transactionId: z.string().optional().describe('Transaction ID to query status for'),
});

const changeAvailabilityV21Body = z.object({
  stationId: stationIdField,
  operationalStatus: operationalStatusEnum.describe('Operational status'),
  evse: evseType.optional().describe('Target EVSE (omit for whole station)'),
});

const unlockConnectorV21Body = z.object({
  stationId: stationIdField,
  evseId: z.number().int().describe('EVSE ID'),
  connectorId: z.number().int().describe('Connector ID'),
});

const triggerMessageV21Body = z.object({
  stationId: stationIdField,
  requestedMessage: messageTriggerEnumV21.describe('Message type to trigger'),
  evse: evseType.optional().describe('Target EVSE'),
  customTrigger: z.string().optional().describe('Custom trigger identifier'),
});

const getLocalListVersionV21Body = z.object({
  stationId: stationIdField,
});

const sendLocalListV21Body = z.object({
  stationId: stationIdField,
  versionNumber: z.number().int().describe('List version number'),
  updateType: updateEnum.describe('Update type (Differential or Full)'),
  localAuthorizationList: z.array(authorizationData).optional().describe('Authorization entries'),
});

const setChargingProfileV21Body = z.object({
  stationId: stationIdField,
  evseId: z.number().int().describe('EVSE ID'),
  chargingProfile: chargingProfileTypeV21.describe('Charging profile to set'),
});

const clearChargingProfileV21Body = z.object({
  stationId: stationIdField,
  chargingProfileId: z.number().int().optional().describe('Charging profile ID to clear'),
  chargingProfileCriteria: clearChargingProfileType.optional().describe('Criteria for clearing'),
});

const getChargingProfilesV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  evseId: z.number().int().optional().describe('EVSE ID (0 = grid connection, omit for all)'),
  chargingProfile: chargingProfileCriterionType.describe('Charging profile filter criteria'),
});

const getCompositeScheduleV21Body = z.object({
  stationId: stationIdField,
  duration: z.number().int().describe('Duration in seconds'),
  evseId: z.number().int().describe('EVSE ID'),
  chargingRateUnit: chargingRateUnitEnumV21.optional().describe('Preferred rate unit'),
});

const clearCacheV21Body = z.object({
  stationId: stationIdField,
});

const updateFirmwareV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  firmware: firmwareType.describe('Firmware details'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

const reserveNowV21Body = z.object({
  stationId: stationIdField,
  id: z.number().int().describe('Reservation ID'),
  expiryDateTime: z.string().describe('ISO 8601 reservation expiry'),
  idToken: idTokenType.describe('ID token for reservation'),
  connectorType: z.string().optional().describe('Connector type filter'),
  evseId: z.number().int().optional().describe('EVSE ID'),
  groupIdToken: idTokenType.optional().describe('Group ID token'),
});

const cancelReservationV21Body = z.object({
  stationId: stationIdField,
  reservationId: z.number().int().describe('Reservation ID to cancel'),
});

const dataTransferV21Body = z.object({
  stationId: stationIdField,
  vendorId: z.string().describe('Vendor identifier'),
  messageId: z.string().optional().describe('Message identifier'),
  data: z.unknown().optional().describe('Data payload'),
});

const getVariablesV21Body = z.object({
  stationId: stationIdField,
  getVariableData: z.array(getVariableDataType).describe('Variables to get'),
});

const setVariablesV21Body = z.object({
  stationId: stationIdField,
  setVariableData: z.array(setVariableDataType).describe('Variables to set'),
});

const getLogV21Body = z.object({
  stationId: stationIdField,
  logType: logEnum.describe('Log type'),
  requestId: z.number().int().describe('Request ID'),
  log: logParametersType.describe('Log parameters'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

const certificateSignedV21Body = z.object({
  stationId: stationIdField,
  certificateChain: z.string().describe('PEM encoded certificate chain'),
  certificateType: certificateSigningUseEnum.optional().describe('Certificate type'),
  requestId: z.number().int().optional().describe('Request ID from SignCertificate'),
});

const installCertificateV21Body = z.object({
  stationId: stationIdField,
  certificateType: installCertificateUseEnum.describe('Certificate type to install'),
  certificate: z.string().describe('PEM encoded certificate'),
});

const deleteCertificateV21Body = z.object({
  stationId: stationIdField,
  certificateHashData: certificateHashDataType.describe('Certificate hash data'),
});

const getInstalledCertificateIdsV21Body = z.object({
  stationId: stationIdField,
  certificateType: z
    .array(getCertificateIdUseEnum)
    .optional()
    .describe('Certificate types to query'),
});

const getBaseReportV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  reportBase: reportBaseEnum.describe('Report base type'),
});

const getReportV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  componentVariable: z
    .array(componentVariableType)
    .optional()
    .describe('Component variables to report'),
  componentCriteria: z
    .array(componentCriterionEnum)
    .optional()
    .describe('Component criteria filter'),
});

const setMonitoringBaseV21Body = z.object({
  stationId: stationIdField,
  monitoringBase: monitoringBaseEnum.describe('Monitoring base to set'),
});

const setMonitoringLevelV21Body = z.object({
  stationId: stationIdField,
  severity: z.number().int().describe('Severity level (0-9)'),
});

const setVariableMonitoringV21Body = z.object({
  stationId: stationIdField,
  setMonitoringData: z.array(setMonitoringDataType).describe('Monitoring data to set'),
});

const clearVariableMonitoringV21Body = z.object({
  stationId: stationIdField,
  id: z.array(z.number().int()).describe('Monitor IDs to clear'),
});

const getMonitoringReportV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  componentVariable: z
    .array(componentVariableType)
    .optional()
    .describe('Component variables to report'),
  monitoringCriteria: z
    .array(monitoringCriterionEnum)
    .optional()
    .describe('Monitoring criteria filter'),
});

const setNetworkProfileV21Body = z.object({
  stationId: stationIdField,
  configurationSlot: z.number().int().describe('Configuration slot number'),
  connectionData: networkConnectionProfileType.describe('Network connection profile'),
});

const setDisplayMessageV21Body = z.object({
  stationId: stationIdField,
  message: messageInfoType.describe('Display message to set'),
});

const getDisplayMessagesV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  id: z.array(z.number().int()).optional().describe('Message IDs to query'),
  priority: messagePriorityEnum.optional().describe('Priority filter'),
  state: messageStateEnum.optional().describe('State filter'),
});

const clearDisplayMessageV21Body = z.object({
  stationId: stationIdField,
  id: z.number().int().describe('Display message ID to clear'),
});

const setDefaultTariffV21Body = z.object({
  stationId: stationIdField,
  evseId: z.number().int().describe('EVSE ID'),
  tariff: tariffType.describe('Tariff to set'),
});

const getTariffsV21Body = z.object({
  stationId: stationIdField,
  evseId: z.number().int().describe('EVSE ID'),
});

const clearTariffsV21Body = z.object({
  stationId: stationIdField,
  tariffIds: z.array(z.string()).optional().describe('Tariff IDs to clear'),
  evseId: z.number().int().optional().describe('EVSE ID'),
});

const changeTransactionTariffV21Body = z.object({
  stationId: stationIdField,
  transactionId: z.string().describe('Transaction ID'),
  tariff: tariffType.describe('New tariff'),
});

const customerInformationV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  report: z.boolean().describe('Request report'),
  clear: z.boolean().describe('Clear customer info'),
  customerIdentifier: z.string().optional().describe('Customer identifier'),
  idToken: idTokenType.optional().describe('ID token'),
  customerCertificate: certificateHashDataType.optional().describe('Customer certificate hash'),
});

const costUpdatedV21Body = z.object({
  stationId: stationIdField,
  totalCost: z.number().describe('Total cost'),
  transactionId: z.string().describe('Transaction ID'),
});

const usePriorityChargingV21Body = z.object({
  stationId: stationIdField,
  transactionId: z.string().describe('Transaction ID'),
  activate: z.boolean().describe('Activate or deactivate priority charging'),
});

const updateDynamicScheduleV21Body = z.object({
  stationId: stationIdField,
  chargingProfileId: z.number().int().describe('Charging profile ID'),
  scheduleUpdate: chargingScheduleUpdateType.describe('Schedule update'),
});

const publishFirmwareV21Body = z.object({
  stationId: stationIdField,
  location: z.string().describe('URI of firmware image'),
  checksum: z.string().describe('MD5 checksum of firmware'),
  requestId: z.number().int().describe('Request ID'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

const unpublishFirmwareV21Body = z.object({
  stationId: stationIdField,
  checksum: z.string().describe('MD5 checksum of firmware to unpublish'),
});

const afrrSignalV21Body = z.object({
  stationId: stationIdField,
  timestamp: z.string().describe('ISO 8601 timestamp'),
  signal: z.number().int().describe('AFRR signal value'),
});

const setDERControlV21Body = z.object({
  stationId: stationIdField,
  isDefault: z.boolean().describe('Is default control'),
  controlId: z.string().describe('Control ID'),
  controlType: derControlEnum.describe('DER control type'),
  curve: derCurveType.optional().describe('DER curve'),
  enterService: enterServiceType.optional().describe('Enter service settings'),
  fixedPFAbsorb: fixedPFType.optional().describe('Fixed power factor absorb'),
  fixedPFInject: fixedPFType.optional().describe('Fixed power factor inject'),
  fixedVar: fixedVarType.optional().describe('Fixed var settings'),
  freqDroop: freqDroopType.optional().describe('Frequency droop settings'),
  gradient: gradientType.optional().describe('Gradient settings'),
  limitMaxDischarge: limitMaxDischargeType.optional().describe('Max discharge limit'),
});

const getDERControlV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  isDefault: z.boolean().optional().describe('Filter by default'),
  controlType: derControlEnum.optional().describe('Filter by control type'),
  controlId: z.string().optional().describe('Filter by control ID'),
});

const clearDERControlV21Body = z.object({
  stationId: stationIdField,
  isDefault: z.boolean().describe('Clear default controls'),
  controlType: derControlEnum.optional().describe('Control type to clear'),
  controlId: z.string().optional().describe('Control ID to clear'),
});

const openPeriodicEventStreamV21Body = z.object({
  stationId: stationIdField,
  constantStreamData: constantStreamDataType.describe('Stream configuration'),
});

const closePeriodicEventStreamV21Body = z.object({
  stationId: stationIdField,
  id: z.number().int().describe('Stream ID to close'),
});

const adjustPeriodicEventStreamV21Body = z.object({
  stationId: stationIdField,
  id: z.number().int().describe('Stream ID to adjust'),
  params: periodicEventStreamParamsType.describe('New stream parameters'),
});

const getPeriodicEventStreamV21Body = z.object({
  stationId: stationIdField,
});

const requestBatterySwapV21Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  idToken: idTokenType.describe('ID token'),
});

const vatNumberValidationV21Body = z.object({
  stationId: stationIdField,
  vatNumber: z.string().describe('VAT number to validate'),
  evseId: z.number().int().optional().describe('EVSE ID'),
});

// ===========================================================================
// OCPP 1.6 Command Body Schemas
// ===========================================================================

const remoteStartTransactionV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().optional().describe('Connector ID'),
  idTag: z.string().max(20).describe('ID tag for authorization'),
  chargingProfile: chargingProfileTypeV16.optional().describe('Charging profile'),
});

const remoteStopTransactionV16Body = z.object({
  stationId: stationIdField,
  transactionId: z.number().int().describe('Transaction ID to stop'),
});

const resetV16Body = z.object({
  stationId: stationIdField,
  type: resetTypeEnumV16.describe('Reset type'),
});

const changeAvailabilityV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().describe('Connector ID (0 = charge point)'),
  type: availabilityTypeEnum.describe('Availability type'),
});

const unlockConnectorV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().describe('Connector ID to unlock'),
});

const triggerMessageV16Body = z.object({
  stationId: stationIdField,
  requestedMessage: messageTriggerEnumV16.describe('Message type to trigger'),
  connectorId: z.number().int().optional().describe('Connector ID'),
});

const getLocalListVersionV16Body = z.object({
  stationId: stationIdField,
});

const sendLocalListV16Body = z.object({
  stationId: stationIdField,
  listVersion: z.number().int().describe('List version number'),
  updateType: updateTypeEnum.describe('Update type (Differential or Full)'),
  localAuthorizationList: z
    .array(authorizationDataType)
    .optional()
    .describe('Authorization entries'),
});

const setChargingProfileV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().describe('Connector ID'),
  csChargingProfiles: chargingProfileTypeV16.describe('Charging profile to set'),
});

const clearChargingProfileV16Body = z.object({
  stationId: stationIdField,
  id: z.number().int().optional().describe('Charging profile ID'),
  connectorId: z.number().int().optional().describe('Connector ID'),
  chargingProfilePurpose: chargingProfilePurposeEnumV16
    .optional()
    .describe('Profile purpose filter'),
  stackLevel: z.number().int().optional().describe('Stack level filter'),
});

const getCompositeScheduleV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().describe('Connector ID'),
  duration: z.number().int().describe('Duration in seconds'),
  chargingRateUnit: chargingRateUnitEnumV16.optional().describe('Preferred rate unit'),
});

const clearCacheV16Body = z.object({
  stationId: stationIdField,
});

const updateFirmwareV16Body = z.object({
  stationId: stationIdField,
  location: z.string().describe('URI of firmware image'),
  retrieveDate: z.string().describe('ISO 8601 retrieve date'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

const reserveNowV16Body = z.object({
  stationId: stationIdField,
  connectorId: z.number().int().describe('Connector ID'),
  expiryDate: z.string().describe('ISO 8601 reservation expiry'),
  idTag: z.string().max(20).describe('ID tag for reservation'),
  parentIdTag: z.string().max(20).optional().describe('Parent ID tag'),
  reservationId: z.number().int().describe('Reservation ID'),
});

const cancelReservationV16Body = z.object({
  stationId: stationIdField,
  reservationId: z.number().int().describe('Reservation ID to cancel'),
});

const dataTransferV16Body = z.object({
  stationId: stationIdField,
  vendorId: z.string().max(255).describe('Vendor identifier'),
  messageId: z.string().max(50).optional().describe('Message identifier'),
  data: z.string().optional().describe('Data payload'),
});

const getConfigurationV16Body = z.object({
  stationId: stationIdField,
  key: z.array(z.string().max(50)).optional().describe('Keys to retrieve'),
});

const changeConfigurationV16Body = z.object({
  stationId: stationIdField,
  key: z.string().max(50).describe('Configuration key'),
  value: z.string().max(500).describe('Configuration value'),
});

const getDiagnosticsV16Body = z.object({
  stationId: stationIdField,
  location: z.string().describe('URI for diagnostics upload'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
  startTime: z.string().optional().describe('ISO 8601 log start time'),
  stopTime: z.string().optional().describe('ISO 8601 log end time'),
});

// --- OCPP 1.6 Security Extension Commands ---

const signedUpdateFirmwareV16Body = z.object({
  stationId: stationIdField,
  requestId: z.number().int().describe('Request ID'),
  firmware: z
    .object({
      location: z.string().max(512).describe('URI of firmware image'),
      retrieveDateTime: z.string().describe('ISO 8601 retrieve date'),
      installDateTime: z.string().optional().describe('ISO 8601 install date'),
      signingCertificate: z.string().max(5500).describe('PEM signing certificate'),
      signature: z.string().max(800).describe('Base64 encoded firmware signature'),
    })
    .describe('Signed firmware details'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

const extendedTriggerMessageV16Body = z.object({
  stationId: stationIdField,
  requestedMessage: z
    .enum([
      'BootNotification',
      'LogStatusNotification',
      'FirmwareStatusNotification',
      'Heartbeat',
      'MeterValues',
      'SignChargePointCertificate',
      'StatusNotification',
    ])
    .describe('Message type to trigger'),
  connectorId: z.number().int().optional().describe('Connector ID'),
});

const certificateSignedV16Body = z.object({
  stationId: stationIdField,
  certificateChain: z.string().describe('PEM encoded certificate chain'),
});

const installCertificateV16Body = z.object({
  stationId: stationIdField,
  certificateType: z
    .enum(['CentralSystemRootCertificate', 'ManufacturerRootCertificate'])
    .describe('Certificate type to install'),
  certificate: z.string().max(5500).describe('PEM encoded certificate'),
});

const deleteCertificateV16Body = z.object({
  stationId: stationIdField,
  certificateHashData: z
    .object({
      hashAlgorithm: z.enum(['SHA256', 'SHA384', 'SHA512']).describe('Hash algorithm'),
      issuerNameHash: z.string().max(128).describe('Issuer name hash'),
      issuerKeyHash: z.string().max(128).describe('Issuer key hash'),
      serialNumber: z.string().max(40).describe('Certificate serial number'),
    })
    .describe('Certificate hash data'),
});

const getInstalledCertificateIdsV16Body = z.object({
  stationId: stationIdField,
  certificateType: z
    .enum(['CentralSystemRootCertificate', 'ManufacturerRootCertificate'])
    .describe('Certificate type to query'),
});

const getLogV16Body = z.object({
  stationId: stationIdField,
  logType: z.enum(['DiagnosticsLog', 'SecurityLog']).describe('Log type'),
  requestId: z.number().int().describe('Request ID'),
  log: z
    .object({
      remoteLocation: z.string().max(512).describe('URI for log upload'),
      oldestTimestamp: z.string().optional().describe('ISO 8601 oldest log entry'),
      latestTimestamp: z.string().optional().describe('ISO 8601 latest log entry'),
    })
    .describe('Log parameters'),
  retries: z.number().int().optional().describe('Number of retries'),
  retryInterval: z.number().int().optional().describe('Seconds between retries'),
});

// ===========================================================================
// Route registration
// ===========================================================================

export function ocppCommandRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // OCPP 2.1 Commands
  // -------------------------------------------------------------------------

  commandRoute(app, 'v21', 'Reset', 'ocpp2.1', 'Reset a station', resetV21Body);

  commandRoute(
    app,
    'v21',
    'RequestStartTransaction',
    'ocpp2.1',
    'Request to start a transaction',
    requestStartTransactionV21Body,
  );

  commandRoute(
    app,
    'v21',
    'RequestStopTransaction',
    'ocpp2.1',
    'Request to stop a transaction',
    requestStopTransactionV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetTransactionStatus',
    'ocpp2.1',
    'Get status of a transaction',
    getTransactionStatusV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ChangeAvailability',
    'ocpp2.1',
    'Change station or EVSE availability',
    changeAvailabilityV21Body,
  );

  commandRoute(
    app,
    'v21',
    'UnlockConnector',
    'ocpp2.1',
    'Unlock a connector',
    unlockConnectorV21Body,
  );

  commandRoute(
    app,
    'v21',
    'TriggerMessage',
    'ocpp2.1',
    'Trigger a message from station',
    triggerMessageV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetLocalListVersion',
    'ocpp2.1',
    'Get local authorization list version',
    getLocalListVersionV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SendLocalList',
    'ocpp2.1',
    'Send local authorization list',
    sendLocalListV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetChargingProfile',
    'ocpp2.1',
    'Set a charging profile',
    setChargingProfileV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ClearChargingProfile',
    'ocpp2.1',
    'Clear charging profiles',
    clearChargingProfileV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetChargingProfiles',
    'ocpp2.1',
    'Get charging profiles from station',
    getChargingProfilesV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetCompositeSchedule',
    'ocpp2.1',
    'Get composite charging schedule',
    getCompositeScheduleV21Body,
  );

  commandRoute(app, 'v21', 'ClearCache', 'ocpp2.1', 'Clear authorization cache', clearCacheV21Body);

  commandRoute(
    app,
    'v21',
    'UpdateFirmware',
    'ocpp2.1',
    'Update station firmware',
    updateFirmwareV21Body,
  );

  commandRoute(app, 'v21', 'ReserveNow', 'ocpp2.1', 'Create a reservation', reserveNowV21Body);

  commandRoute(
    app,
    'v21',
    'CancelReservation',
    'ocpp2.1',
    'Cancel a reservation',
    cancelReservationV21Body,
  );

  commandRoute(
    app,
    'v21',
    'DataTransfer',
    'ocpp2.1',
    'Send a vendor-specific data transfer',
    dataTransferV21Body,
  );

  // GetVariables needs custom handling to respect ItemsPerMessageGetVariables limit.
  // The CSMS must split requests that exceed the station's reported limit.
  app.post(
    '/ocpp/commands/v21/GetVariables',
    {
      onRequest: [authorize('stations:write')],
      schema: {
        tags: ['OCPP 2.1 Commands'],
        summary: 'Get station variables',
        operationId: 'ocppv21_GetVariables',
        security: [{ bearerAuth: [] }],
        body: zodSchema(getVariablesV21Body),
        response: commandResponses,
      },
    },
    async (request, reply) => {
      const body = request.body as { stationId: string; getVariableData: unknown[] };
      const { stationId, ...payload } = body;
      const { userId } = request.user as { userId: string };
      const getVariableData = payload.getVariableData;

      // Look up station DB ID for ItemsPerMessage config query
      const [station] = await db
        .select({ id: chargingStations.id })
        .from(chargingStations)
        .where(eq(chargingStations.stationId, stationId));

      let itemsPerMessage = getVariableData.length; // default: no splitting
      if (station != null) {
        // The unique constraint on station_configurations does not include variable_instance,
        // so there may be only one ItemsPerMessage row regardless of instance. Query broadly
        // and prefer the GetVariables instance if multiple rows exist.
        const configs = await db
          .select({
            value: stationConfigurations.value,
            variableInstance: stationConfigurations.variableInstance,
          })
          .from(stationConfigurations)
          .where(
            and(
              eq(stationConfigurations.stationId, station.id),
              eq(stationConfigurations.component, 'DeviceDataCtrlr'),
              eq(stationConfigurations.variable, 'ItemsPerMessage'),
            ),
          );
        const match =
          configs.find((c) => c.variableInstance === 'GetVariables') ?? configs[0] ?? null;
        if (match?.value != null) {
          const parsed = parseInt(match.value, 10);
          if (!isNaN(parsed) && parsed > 0) {
            itemsPerMessage = parsed;
          }
        }
      }

      // If within limit, dispatch as a single command
      if (getVariableData.length <= itemsPerMessage) {
        const result = await dispatchCommandRaw(
          app,
          userId,
          stationId,
          'GetVariables',
          payload,
          'ocpp2.1',
        );
        return reply.status(result.code as 200).send(result.body);
      }

      // Split into chunks and dispatch sequentially, aggregating results
      const chunks: unknown[][] = [];
      for (let i = 0; i < getVariableData.length; i += itemsPerMessage) {
        chunks.push(getVariableData.slice(i, i + itemsPerMessage));
      }

      const allResults: unknown[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkPayload = { getVariableData: chunks[i] };
        const result = await dispatchCommandRaw(
          app,
          userId,
          stationId,
          'GetVariables',
          chunkPayload as Record<string, unknown>,
          'ocpp2.1',
          // Skip validation and site access on subsequent chunks (already checked on first)
          i > 0 ? { skipValidation: true, skipSiteAccess: true } : undefined,
        );
        if (result.code !== 200) {
          return reply.status(result.code as 502).send(result.body);
        }
        const response = result.body['response'] as Record<string, unknown> | undefined;
        const getVariableResult = response?.['getVariableResult'];
        if (Array.isArray(getVariableResult)) {
          allResults.push(...(getVariableResult as Record<string, unknown>[]));
        }
      }

      return reply.status(200).send({
        status: 'accepted',
        stationId,
        action: 'GetVariables',
        response: { getVariableResult: allResults },
      });
    },
  );

  commandRoute(app, 'v21', 'SetVariables', 'ocpp2.1', 'Set station variables', setVariablesV21Body);

  commandRoute(app, 'v21', 'GetLog', 'ocpp2.1', 'Request log upload from station', getLogV21Body);

  commandRoute(
    app,
    'v21',
    'CertificateSigned',
    'ocpp2.1',
    'Send signed certificate to station',
    certificateSignedV21Body,
  );

  commandRoute(
    app,
    'v21',
    'InstallCertificate',
    'ocpp2.1',
    'Install a CA certificate on station',
    installCertificateV21Body,
  );

  commandRoute(
    app,
    'v21',
    'DeleteCertificate',
    'ocpp2.1',
    'Delete a certificate from station',
    deleteCertificateV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetInstalledCertificateIds',
    'ocpp2.1',
    'Query installed certificate IDs',
    getInstalledCertificateIdsV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetBaseReport',
    'ocpp2.1',
    'Get base report from station',
    getBaseReportV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetReport',
    'ocpp2.1',
    'Get detailed report from station',
    getReportV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetMonitoringBase',
    'ocpp2.1',
    'Set monitoring base configuration',
    setMonitoringBaseV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetMonitoringLevel',
    'ocpp2.1',
    'Set monitoring severity level',
    setMonitoringLevelV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetVariableMonitoring',
    'ocpp2.1',
    'Set variable monitoring rules',
    setVariableMonitoringV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ClearVariableMonitoring',
    'ocpp2.1',
    'Clear variable monitoring rules',
    clearVariableMonitoringV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetMonitoringReport',
    'ocpp2.1',
    'Get monitoring report',
    getMonitoringReportV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetNetworkProfile',
    'ocpp2.1',
    'Set network connection profile',
    setNetworkProfileV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetDisplayMessage',
    'ocpp2.1',
    'Set a display message on station',
    setDisplayMessageV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetDisplayMessages',
    'ocpp2.1',
    'Get display messages from station',
    getDisplayMessagesV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ClearDisplayMessage',
    'ocpp2.1',
    'Clear a display message',
    clearDisplayMessageV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetDefaultTariff',
    'ocpp2.1',
    'Set default tariff on station',
    setDefaultTariffV21Body,
  );

  commandRoute(app, 'v21', 'GetTariffs', 'ocpp2.1', 'Get tariffs from station', getTariffsV21Body);

  commandRoute(
    app,
    'v21',
    'ClearTariffs',
    'ocpp2.1',
    'Clear tariffs from station',
    clearTariffsV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ChangeTransactionTariff',
    'ocpp2.1',
    'Change tariff for active transaction',
    changeTransactionTariffV21Body,
  );

  commandRoute(
    app,
    'v21',
    'CustomerInformation',
    'ocpp2.1',
    'Request or clear customer information',
    customerInformationV21Body,
  );

  commandRoute(
    app,
    'v21',
    'CostUpdated',
    'ocpp2.1',
    'Send updated cost to station',
    costUpdatedV21Body,
  );

  commandRoute(
    app,
    'v21',
    'UsePriorityCharging',
    'ocpp2.1',
    'Activate or deactivate priority charging',
    usePriorityChargingV21Body,
  );

  commandRoute(
    app,
    'v21',
    'UpdateDynamicSchedule',
    'ocpp2.1',
    'Update dynamic charging schedule',
    updateDynamicScheduleV21Body,
  );

  commandRoute(
    app,
    'v21',
    'PublishFirmware',
    'ocpp2.1',
    'Publish firmware to local controller',
    publishFirmwareV21Body,
  );

  commandRoute(
    app,
    'v21',
    'UnpublishFirmware',
    'ocpp2.1',
    'Unpublish firmware from local controller',
    unpublishFirmwareV21Body,
  );

  commandRoute(
    app,
    'v21',
    'AFRRSignal',
    'ocpp2.1',
    'Send AFRR signal to station',
    afrrSignalV21Body,
  );

  commandRoute(
    app,
    'v21',
    'SetDERControl',
    'ocpp2.1',
    'Set DER control on station',
    setDERControlV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetDERControl',
    'ocpp2.1',
    'Get DER control settings from station',
    getDERControlV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ClearDERControl',
    'ocpp2.1',
    'Clear DER control settings',
    clearDERControlV21Body,
  );

  commandRoute(
    app,
    'v21',
    'OpenPeriodicEventStream',
    'ocpp2.1',
    'Open periodic event stream',
    openPeriodicEventStreamV21Body,
  );

  commandRoute(
    app,
    'v21',
    'ClosePeriodicEventStream',
    'ocpp2.1',
    'Close periodic event stream',
    closePeriodicEventStreamV21Body,
  );

  commandRoute(
    app,
    'v21',
    'AdjustPeriodicEventStream',
    'ocpp2.1',
    'Adjust periodic event stream',
    adjustPeriodicEventStreamV21Body,
  );

  commandRoute(
    app,
    'v21',
    'GetPeriodicEventStream',
    'ocpp2.1',
    'Get periodic event streams',
    getPeriodicEventStreamV21Body,
  );

  commandRoute(
    app,
    'v21',
    'RequestBatterySwap',
    'ocpp2.1',
    'Request battery swap',
    requestBatterySwapV21Body,
  );

  commandRoute(
    app,
    'v21',
    'VatNumberValidation',
    'ocpp2.1',
    'Validate VAT number',
    vatNumberValidationV21Body,
  );

  // -------------------------------------------------------------------------
  // OCPP 1.6 Commands
  // -------------------------------------------------------------------------

  commandRoute(
    app,
    'v16',
    'RemoteStartTransaction',
    'ocpp1.6',
    'Remote start a transaction',
    remoteStartTransactionV16Body,
  );

  commandRoute(
    app,
    'v16',
    'RemoteStopTransaction',
    'ocpp1.6',
    'Remote stop a transaction',
    remoteStopTransactionV16Body,
  );

  commandRoute(app, 'v16', 'Reset', 'ocpp1.6', 'Reset a station', resetV16Body);

  commandRoute(
    app,
    'v16',
    'ChangeAvailability',
    'ocpp1.6',
    'Change connector availability',
    changeAvailabilityV16Body,
  );

  commandRoute(
    app,
    'v16',
    'UnlockConnector',
    'ocpp1.6',
    'Unlock a connector',
    unlockConnectorV16Body,
  );

  commandRoute(
    app,
    'v16',
    'TriggerMessage',
    'ocpp1.6',
    'Trigger a message from station',
    triggerMessageV16Body,
  );

  commandRoute(
    app,
    'v16',
    'GetLocalListVersion',
    'ocpp1.6',
    'Get local authorization list version',
    getLocalListVersionV16Body,
  );

  commandRoute(
    app,
    'v16',
    'SendLocalList',
    'ocpp1.6',
    'Send local authorization list',
    sendLocalListV16Body,
  );

  commandRoute(
    app,
    'v16',
    'SetChargingProfile',
    'ocpp1.6',
    'Set a charging profile',
    setChargingProfileV16Body,
  );

  commandRoute(
    app,
    'v16',
    'ClearChargingProfile',
    'ocpp1.6',
    'Clear charging profiles',
    clearChargingProfileV16Body,
  );

  commandRoute(
    app,
    'v16',
    'GetCompositeSchedule',
    'ocpp1.6',
    'Get composite charging schedule',
    getCompositeScheduleV16Body,
  );

  commandRoute(app, 'v16', 'ClearCache', 'ocpp1.6', 'Clear authorization cache', clearCacheV16Body);

  commandRoute(
    app,
    'v16',
    'UpdateFirmware',
    'ocpp1.6',
    'Update station firmware',
    updateFirmwareV16Body,
  );

  commandRoute(app, 'v16', 'ReserveNow', 'ocpp1.6', 'Create a reservation', reserveNowV16Body);

  commandRoute(
    app,
    'v16',
    'CancelReservation',
    'ocpp1.6',
    'Cancel a reservation',
    cancelReservationV16Body,
  );

  commandRoute(
    app,
    'v16',
    'DataTransfer',
    'ocpp1.6',
    'Send a vendor-specific data transfer',
    dataTransferV16Body,
  );

  commandRoute(
    app,
    'v16',
    'GetConfiguration',
    'ocpp1.6',
    'Get station configuration keys',
    getConfigurationV16Body,
  );

  commandRoute(
    app,
    'v16',
    'ChangeConfiguration',
    'ocpp1.6',
    'Change a station configuration key',
    changeConfigurationV16Body,
  );

  commandRoute(
    app,
    'v16',
    'GetDiagnostics',
    'ocpp1.6',
    'Request diagnostics upload',
    getDiagnosticsV16Body,
  );

  commandRoute(
    app,
    'v16',
    'SignedUpdateFirmware',
    'ocpp1.6',
    'Update firmware with signature verification',
    signedUpdateFirmwareV16Body,
  );

  commandRoute(
    app,
    'v16',
    'ExtendedTriggerMessage',
    'ocpp1.6',
    'Trigger an extended message from station',
    extendedTriggerMessageV16Body,
  );

  commandRoute(
    app,
    'v16',
    'CertificateSigned',
    'ocpp1.6',
    'Send signed certificate to station',
    certificateSignedV16Body,
  );

  commandRoute(
    app,
    'v16',
    'InstallCertificate',
    'ocpp1.6',
    'Install a CA certificate on station',
    installCertificateV16Body,
  );

  commandRoute(
    app,
    'v16',
    'DeleteCertificate',
    'ocpp1.6',
    'Delete a certificate from station',
    deleteCertificateV16Body,
  );

  commandRoute(
    app,
    'v16',
    'GetInstalledCertificateIds',
    'ocpp1.6',
    'Query installed certificate IDs',
    getInstalledCertificateIdsV16Body,
  );

  commandRoute(app, 'v16', 'GetLog', 'ocpp1.6', 'Request log upload from station', getLogV16Body);
}
