// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { chargingSessions, connectors, evses, stationUnits } from '@evtivity/database';

// Aliased so a session list that also joins the station's EVSEs or units
// never collides with these joins.
export const sessionEvse = alias(evses, 'session_evse');
export const sessionUnit = alias(stationUnits, 'session_unit');
export const sessionConnector = alias(connectors, 'session_connector');

/**
 * The charging point of a session: the EVSE and connector stored on the
 * session row, and the unit that EVSE belongs to now.
 */
export const sessionChargingPointColumns = {
  evseId: sessionEvse.evseId,
  unitName: sessionUnit.name,
  connectorId: sessionConnector.connectorId,
  connectorType: sessionConnector.connectorType,
};

export const sessionEvseJoin = eq(sessionEvse.id, chargingSessions.evseId);
export const sessionUnitJoin = eq(sessionUnit.id, sessionEvse.unitId);
export const sessionConnectorJoin = eq(sessionConnector.id, chargingSessions.connectorId);

export const sessionChargingPointShape = {
  evseId: z
    .number()
    .int()
    .nullable()
    .describe('OCPP EVSE number the session charged on, null when unknown'),
  unitName: z
    .string()
    .nullable()
    .describe('Unit (physical box) the EVSE of the session belongs to now, null when it has none'),
  connectorId: z
    .number()
    .int()
    .nullable()
    .describe('OCPP connector number on the EVSE, null when unknown'),
  connectorType: z
    .string()
    .nullable()
    .describe('Connector type (CCS2, Type2, ...), null when unknown'),
};
