// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import 'reflect-metadata';
import { container } from 'tsyringe';

export { container, injectable, inject, singleton } from 'tsyringe';
export type { DependencyContainer } from 'tsyringe';

export function resetContainer(): void {
  container.clearInstances();
}
