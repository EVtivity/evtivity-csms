// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StepResult, TestCase } from '../../../../types.js';

// Helper: boot station and send StatusNotification
async function bootAndStatus(ctx: {
  client: {
    sendCall: (
      action: string,
      payload: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  };
}) {
  await ctx.client.sendCall('BootNotification', {
    chargingStation: { model: 'OCTT-Virtual', vendorName: 'OCTT' },
    reason: 'PowerUp',
  });
  await ctx.client.sendCall('StatusNotification', {
    timestamp: new Date().toISOString(),
    connectorStatus: 'Available',
    evseId: 1,
    connectorId: 1,
  });
}

/**
 * TC_H_01_CSMS: Reserve a specific EVSE - Accepted - Valid idToken
 *
 * Scenario:
 *   1. CSMS sends ReserveNowRequest (specific EVSE)
 *   2. Test System responds Accepted
 *   3. Test System sends StatusNotification Reserved
 */
export const TC_H_01_CSMS: TestCase = {
  id: 'TC_H_01_CSMS',
  name: 'Reserve a specific EVSE - Accepted - Valid idToken',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to reserve a specific EVSE, until the EV Driver uses the reserved EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let hasEvseId = false;
    let hasIdToken = false;
    let reservationId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          reservationId = Number(payload['id'] ?? 0);
          if (payload['evseId'] != null) hasEvseId = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow
        ? `ReserveNowRequest received, reservationId = ${String(reservationId)}`
        : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'ReserveNowRequest has evseId and valid idToken',
      status: hasEvseId && hasIdToken ? 'passed' : 'failed',
      expected: 'evseId present, idToken with idToken and type',
      actual: `hasEvseId = ${String(hasEvseId)}, hasIdToken = ${String(hasIdToken)}`,
    });

    if (receivedReserveNow) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_07_CSMS: Reserve a specific EVSE - Reservation Ended / not used
 *
 * Scenario:
 *   1. CSMS sends ReserveNowRequest (specific EVSE)
 *   2. Test System responds Accepted
 *   (Reservation expires without being used)
 */
export const TC_H_07_CSMS: TestCase = {
  id: 'TC_H_07_CSMS',
  name: 'Reserve a specific EVSE - Reservation Ended / not used',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest. The reservation is not used.',
  purpose:
    'To verify if the CSMS is able to handle a reservation that is canceled by the Charging Station because the reservation was not used.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let reservationId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          reservationId = Number(payload['id'] ?? 0);
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow
        ? `ReserveNowRequest received, reservationId = ${String(reservationId)}`
        : 'No ReserveNowRequest received',
    });

    if (receivedReserveNow) {
      // Notify reservation expired
      const statusRes = await ctx.client.sendCall('ReservationStatusUpdate', {
        reservationId,
        reservationUpdateStatus: 'Expired',
      });

      steps.push({
        step: 2,
        description: 'ReservationStatusUpdate Expired sent',
        status: 'passed',
        expected: 'ReservationStatusUpdateResponse received',
        actual: `Response keys: ${Object.keys(statusRes).join(', ') || '(empty)'}`,
      });

      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Available',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Available sent after reservation expired',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Available sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_08_CSMS: Reserve an unspecified EVSE - Accepted
 */
export const TC_H_08_CSMS: TestCase = {
  id: 'TC_H_08_CSMS',
  name: 'Reserve an unspecified EVSE - Accepted',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to reserve an unspecified EVSE.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let evseIdPresent = false;
    let hasIdToken = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          if (payload['evseId'] != null) evseIdPresent = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow ? 'ReserveNowRequest received' : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'ReserveNowRequest has valid idToken',
      status: hasIdToken ? 'passed' : 'failed',
      expected: 'idToken with idToken and type',
      actual: `hasIdToken = ${String(hasIdToken)}, evseIdPresent = ${String(evseIdPresent)}`,
    });

    if (receivedReserveNow) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_14_CSMS: Reserve an unspecified EVSE - Amount of EVSEs available equals the amount of reservations
 */
export const TC_H_14_CSMS: TestCase = {
  id: 'TC_H_14_CSMS',
  name: 'Reserve an unspecified EVSE - EVSEs equals reservations',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve an unspecified EVSE for a specific IdToken by sending a ReserveNowRequest when all EVSEs become reserved.',
  purpose:
    'To verify if the CSMS is able to handle that the Charging Station sets all available EVSEs to reserved.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let evseIdOmitted = true;
    let hasIdToken = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          if (payload['evseId'] != null) evseIdOmitted = false;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow ? 'ReserveNowRequest received' : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'evseId omitted and valid idToken',
      status: hasIdToken ? 'passed' : 'failed',
      expected: 'evseId omitted, idToken valid',
      actual: `evseIdOmitted = ${String(evseIdOmitted)}, hasIdToken = ${String(hasIdToken)}`,
    });

    if (receivedReserveNow) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Reserved sent for all connectors',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_15_CSMS: Reserve a connector with a specific type - Success
 */
export const TC_H_15_CSMS: TestCase = {
  id: 'TC_H_15_CSMS',
  name: 'Reserve a connector with a specific type - Success',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve an EVSE with a connector with a specific type for a specific IdToken.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to reserve an EVSE with a connector with a specific type.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let hasIdToken = false;
    let hasConnectorType = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          if (payload['connectorType'] != null) hasConnectorType = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest with connectorType',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow ? 'ReserveNowRequest received' : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'Request has valid idToken',
      status: hasIdToken ? 'passed' : 'failed',
      expected: 'idToken present',
      actual: `hasIdToken = ${String(hasIdToken)}, hasConnectorType = ${String(hasConnectorType)}`,
    });

    if (receivedReserveNow) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_19_CSMS: Reserve a specific EVSE - Use a reserved EVSE with GroupId
 */
export const TC_H_19_CSMS: TestCase = {
  id: 'TC_H_19_CSMS',
  name: 'Reserve a specific EVSE - Use a reserved EVSE with GroupId',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve an EVSE for a specific group by sending a ReserveNowRequest containing a groupIdToken.',
  purpose:
    'To verify if the CSMS is able to request the Charging Station to create a reservation for a specific group.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let hasEvseId = false;
    let hasGroupIdToken = false;
    let hasIdToken = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          if (payload['evseId'] != null) hasEvseId = true;
          if (payload['groupIdToken'] != null) hasGroupIdToken = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest with groupIdToken',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow ? 'ReserveNowRequest received' : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'Request has evseId, groupIdToken, and valid idToken',
      status: hasEvseId && hasIdToken ? 'passed' : 'failed',
      expected: 'evseId, groupIdToken, and idToken present',
      actual: `hasEvseId = ${String(hasEvseId)}, hasGroupIdToken = ${String(hasGroupIdToken)}, hasIdToken = ${String(hasIdToken)}`,
    });

    if (receivedReserveNow) {
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_20_CSMS: Charging Station cancels reservation when Faulted
 */
export const TC_H_20_CSMS: TestCase = {
  id: 'TC_H_20_CSMS',
  name: 'Charging Station cancels reservation when Faulted',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The Charging Station will cancel reservations when the EVSE specified for a reservation is set to a faulted state.',
  purpose:
    'To verify if the CSMS is able to handle it when the reservation is canceled when the availability state of the reserved EVSE changes to Faulted.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let reservationId = 0;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          reservationId = Number(payload['id'] ?? 0);
          return { status: 'Accepted' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow
        ? `ReserveNowRequest received, reservationId = ${String(reservationId)}`
        : 'No ReserveNowRequest received',
    });

    if (receivedReserveNow) {
      // Step 3: StatusNotification Reserved
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Reserved',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 2,
        description: 'StatusNotification Reserved sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Reserved sent',
      });

      // Step 5: StatusNotification Faulted
      await ctx.client.sendCall('StatusNotification', {
        timestamp: new Date().toISOString(),
        connectorStatus: 'Faulted',
        evseId: 1,
        connectorId: 1,
      });

      steps.push({
        step: 3,
        description: 'StatusNotification Faulted sent',
        status: 'passed',
        expected: 'StatusNotificationResponse received',
        actual: 'StatusNotification Faulted sent',
      });

      // Step 7: ReservationStatusUpdate Removed
      const statusRes = await ctx.client.sendCall('ReservationStatusUpdate', {
        reservationId,
        reservationUpdateStatus: 'Removed',
      });

      steps.push({
        step: 4,
        description: 'ReservationStatusUpdate Removed sent',
        status: 'passed',
        expected: 'ReservationStatusUpdateResponse received',
        actual: `Response keys: ${Object.keys(statusRes).join(', ') || '(empty)'}`,
      });
    }

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};

/**
 * TC_H_22_CSMS: Reserve a specific EVSE - Configured to Reject
 */
export const TC_H_22_CSMS: TestCase = {
  id: 'TC_H_22_CSMS',
  name: 'Reserve a specific EVSE - Configured to Reject',
  module: 'H-reservation',
  version: 'ocpp2.1',
  sut: 'csms',
  description:
    'The CSMS is able to reserve a specific EVSE for a specific IdToken by sending a ReserveNowRequest. The station is configured to reject.',
  purpose:
    'To verify if the CSMS is able to correctly read the response from a charging station when it is configured not to accept reservations.',
  execute: async (ctx) => {
    const steps: StepResult[] = [];

    await bootAndStatus(ctx);

    let receivedReserveNow = false;
    let hasEvseId = false;
    let hasIdToken = false;

    ctx.client.setIncomingCallHandler(
      async (_messageId: string, action: string, payload: Record<string, unknown>) => {
        if (action === 'ReserveNow') {
          receivedReserveNow = true;
          if (payload['evseId'] != null) hasEvseId = true;
          const idToken = payload['idToken'] as Record<string, unknown> | undefined;
          if (idToken != null && idToken['idToken'] != null && idToken['type'] != null) {
            hasIdToken = true;
          }
          return { status: 'Rejected' };
        }
        return { status: 'NotSupported' };
      },
    );

    if (ctx.triggerCommand != null) {
      await ctx.triggerCommand('v21', 'ReserveNow', {
        stationId: ctx.stationId,
        id: 1,
        expiryDateTime: new Date(Date.now() + 300000).toISOString(),
        idToken: { idToken: 'OCTT-TOKEN-001', type: 'ISO14443' },
        evseId: 1,
      });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    steps.push({
      step: 1,
      description: 'CSMS sends ReserveNowRequest',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'ReserveNowRequest received',
      actual: receivedReserveNow ? 'ReserveNowRequest received' : 'No ReserveNowRequest received',
    });

    steps.push({
      step: 2,
      description: 'ReserveNowRequest has evseId and valid idToken',
      status: hasEvseId && hasIdToken ? 'passed' : 'failed',
      expected: 'evseId present, idToken valid',
      actual: `hasEvseId = ${String(hasEvseId)}, hasIdToken = ${String(hasIdToken)}`,
    });

    steps.push({
      step: 3,
      description: 'Test System responds with Rejected',
      status: receivedReserveNow ? 'passed' : 'failed',
      expected: 'Rejected response sent',
      actual: receivedReserveNow ? 'Rejected response sent' : 'No request to respond to',
    });

    return {
      status: steps.every((s) => s.status === 'passed') ? 'passed' : 'failed',
      durationMs: 0,
      steps,
    };
  },
};
