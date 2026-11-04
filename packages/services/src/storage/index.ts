// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Object storage (`@evtivity/services/storage`): the provider-neutral
 * `ObjectStorage` contract, its S3 and Cloudflare R2 implementations, the
 * endpoint checks of S3-compatible providers and R2, and the loader that
 * builds the configured one from settings.
 */

export * from './object-storage.js';
export * from './s3-object-storage.js';
export * from './r2-object-storage.js';
export * from './storage-endpoint.js';
export * from './load-object-storage.js';
