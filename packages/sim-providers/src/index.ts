// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export type {
  HologramSettings,
  OneNceSettings,
  SimAlert,
  SimAlertKind,
  SimCapabilities,
  SimConnectionResult,
  SimOrganizationCount,
  SimPage,
  SimProvider,
  SimProviderErrorKind,
  SimProviderId,
  SimProviderSettings,
  SimRef,
  SimResetResult,
  SimSession,
  SimState,
  SimStatus,
  SimTimeRange,
  SimUsage,
} from './types.js';
export { SimProviderError } from './types.js';
export type {
  SimProviderBuildOptions,
  SimProviderFactory,
  SimProviderRegistryOptions,
} from './registry.js';
export { SIM_PROVIDER_ORDER, SimProviderRegistry } from './registry.js';
export type { HologramProviderOptions } from './hologram/adapter.js';
export {
  HOLOGRAM_ALERT_TOPICS,
  HOLOGRAM_HISTORY_DAYS,
  HOLOGRAM_REPORTING_DELAY_HOURS,
  HologramProvider,
  hologramFactory,
} from './hologram/adapter.js';
export { HOLOGRAM_BASE_URL } from './hologram/client.js';
export { HOLOGRAM_NETWORK_STATES, mapHologramState } from './hologram/states.js';
export type { OneNceProviderOptions } from './1nce/adapter.js';
export {
  ONENCE_EVENT_PAGE_CAP,
  ONENCE_EVENT_PAGE_SIZE,
  ONENCE_HISTORY_DAYS,
  ONENCE_PDP_EVENT_TYPES,
  ONENCE_REPORTING_DELAY_HOURS,
  ONENCE_SESSION_DETAIL_FIELDS,
  OneNceProvider,
  oneNceConfigured,
  oneNceFactory,
} from './1nce/adapter.js';
export { ONENCE_BASE_URL } from './1nce/client.js';
export { mapOneNceState } from './1nce/states.js';
