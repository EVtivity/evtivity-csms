// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface CodegenConfig {
  schemasDir: string;
  outputDir: string;
  version: string;
  /**
   * Emit fit functions (validator files, validators index, registry). Only OCPP 2.0.1: the CSMS
   * builds its payloads in the 2.1 shape and fits them to the 2.0.1 schema for a 2.0.1 station.
   */
  fitFunctions: boolean;
}

export function resolveConfig(version: string): CodegenConfig {
  const root = path.resolve(__dirname, '../../..');
  const versionSlug = version.replace(/\./g, '_');
  return {
    schemasDir: path.join(root, 'schemas', `ocpp-${version}`),
    outputDir: path.join(root, 'packages', 'ocpp', 'src', 'generated', `v${versionSlug}`),
    version,
    fitFunctions: version === '2.0.1',
  };
}
