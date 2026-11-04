// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * API to API: a depot system changed (`{ id, close }`), a newer connection of
 * one replaced the older (`{ id, kickExcept }`), or the bus depot interface
 * switch changed (`{ all: true }`). Every API process reloads or closes its
 * live depot connections (Redis ACL: api only).
 */
export const DEPOT_SYSTEM_CHANGED_CHANNEL = 'depot_system_changed';
