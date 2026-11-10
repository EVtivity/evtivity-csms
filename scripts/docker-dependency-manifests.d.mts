// Types for docker-dependency-manifests.mjs, which plain node runs without a build step.

export const STRIPPED_VERSION: '0.0.0';
export function stripLock<T>(lock: T): T;
export function stripManifest<T>(pkg: T): T;
export function copyStripped(src: string, dest: string): void;
