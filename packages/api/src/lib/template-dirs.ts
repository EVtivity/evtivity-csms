// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));

export const API_TEMPLATES_DIR =
  process.env['API_TEMPLATES_DIR'] ?? resolve(currentDir, '..', 'templates');
export const OCPP_TEMPLATES_DIR =
  process.env['OCPP_TEMPLATES_DIR'] ??
  resolve(currentDir, '..', '..', '..', 'ocpp', 'src', 'templates');
export const ALL_TEMPLATES_DIRS = [OCPP_TEMPLATES_DIR, API_TEMPLATES_DIR];
