// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Plug & Charge commands from the API to the OCPP server, where the PKI
 * providers live. Every OCPP pod handles the command; the API takes the first
 * reply.
 */
export const PNC_COMMANDS_CHANNEL = 'pnc_commands';
export const PNC_COMMAND_RESULTS_CHANNEL = 'pnc_command_results';

export interface PncCommand {
  commandId: string;
  /** Fetch the root certificates from the configured PKI provider and store the new ones. */
  action: 'refreshRootCertificates';
}

export type PncCommandResult =
  | {
      commandId: string;
      /** Certificates the provider returned. */
      fetched: number;
      /** Root certificates not stored before. */
      added: number;
      error?: undefined;
    }
  | { commandId: string; error: string };
