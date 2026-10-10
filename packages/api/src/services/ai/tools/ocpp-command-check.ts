// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * The deterministic OCPP version check of a proposed station command (the
 * `checkWrite` turn hook). Models pick a 1.6 tool for a 2.1 station (or the
 * reverse) even when told the version, and the versioned command routes send
 * the payload unchanged, so the engine checks every OCPP command write before
 * the confirmation card exists:
 *
 * - The station is looked up as the caller may see it (`findCommandStation`,
 *   the command routes' own lookup with the caller's site scope), and only
 *   when the caller may read stations. Without `stations:read` the call is
 *   proposed unchanged and the route answers it on confirm.
 * - An unknown station or one outside the caller's sites is refused as the
 *   route would refuse it (not found), without telling the two apart.
 * - A tool of the other version becomes its equivalent with translated
 *   arguments (`mapOcppCommand`), checked against the target tool's schema
 *   and policy, and the card shows the translated command. Without an
 *   equivalent the model gets a tool error naming the station's version.
 */

import { findCommandStation } from '../../../lib/command-station.js';
import type { CommandStation } from '../../../lib/command-station.js';
import type { WriteCheck } from '../engine/turn-runner.js';
import { chatbotToolset } from '../surfaces/toolsets.js';
import { AI_TOOL_CATALOG } from './catalog.js';
import { createToolset, prepareToolCall } from './execute.js';
import type { ToolsetEntry } from './execute.js';
import { mapOcppCommand, ocppVersionLabel, toolOcppVersion } from './ocpp-version.js';
import type { MapOptions, OcppVersion } from './ocpp-version.js';
import { redactToolValue } from './redact.js';

export interface OcppCheckCaller {
  userId: string;
  hasPermission: (permission: string) => Promise<boolean>;
}

export interface OcppCheckDeps extends MapOptions {
  findStation?: (userId: string, ocppStationId: string) => Promise<CommandStation | null>;
}

function isOcppVersion(value: string | null): value is OcppVersion {
  return value === 'ocpp1.6' || value === 'ocpp2.1';
}

export async function checkOcppCommandVersion(
  caller: OcppCheckCaller,
  call: { entry: ToolsetEntry; args: Record<string, unknown> },
  deps: OcppCheckDeps = {},
): Promise<WriteCheck> {
  const unchanged: WriteCheck = { ok: true, entry: call.entry, args: call.args };
  if (toolOcppVersion(call.entry.tool) === null) return unchanged;
  const stationId = call.args['stationId'];
  if (typeof stationId !== 'string') return unchanged;
  if (!(await caller.hasPermission('stations:read'))) return unchanged;

  const station = await (deps.findStation ?? findCommandStation)(caller.userId, stationId);
  if (station === null) {
    return {
      ok: false,
      refusal: {
        reason: 'station_not_found',
        modelText: `Station not found: ${stationId}. Check the station ID with a station lookup.`,
      },
    };
  }
  // A station that never connected has no version yet; the route accepts both.
  if (!isOcppVersion(station.ocppProtocol)) return unchanged;
  const stationVersion = station.ocppProtocol;

  const mapping = mapOcppCommand(call.entry.tool, call.args, stationVersion, deps);
  if (mapping.kind === 'match') return unchanged;
  if (mapping.kind === 'unsupported') {
    return { ok: false, refusal: { reason: 'ocpp_version_mismatch', modelText: mapping.message } };
  }

  const label = ocppVersionLabel(stationVersion);
  const prefix = stationVersion === 'ocpp1.6' ? 'ocppv16_' : 'ocppv21_';
  const intro = `Station ${stationId} uses ${label}, but ${call.entry.tool.name} is not an ${label} command.`;
  const target = AI_TOOL_CATALOG.find((t) => t.operationId === mapping.operationId);
  const entry =
    target !== undefined ? chatbotToolset([target.category]).byName.get(target.name) : undefined;
  if (target === undefined || entry === undefined) {
    return {
      ok: false,
      refusal: {
        reason: 'ocpp_version_mismatch',
        modelText: `${intro} Its ${label} equivalent is not available to the assistant.`,
      },
    };
  }
  const prepared = prepareToolCall(createToolset([entry]), target.name, mapping.args);
  if (!prepared.ok) {
    return {
      ok: false,
      refusal: {
        reason: 'ocpp_version_mismatch',
        modelText: `${intro} Translated to ${target.name}, the arguments are not valid (${prepared.refusal.modelText}). Call ${target.name} with valid arguments.`,
      },
    };
  }
  const shown = JSON.stringify(redactToolValue(prepared.args, 'chatbot').value);
  return {
    ok: true,
    entry: prepared.entry,
    args: prepared.args,
    note: `${intro} The call was proposed as its ${label} equivalent instead, ${target.name} with ${shown}, and the confirmation card shows that command. Use only ${prefix} tools for this station.`,
  };
}
