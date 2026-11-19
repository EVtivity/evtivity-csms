// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Coverage guard for the site isolation matrix: every operator route must be
// tested by the matrix integration test or allowlisted with a reason. A new
// route fails here until it is classified in
// helpers/site-isolation-matrix.ts.
//
// The scanner parses every source file under routes/ and plugins/ (nested
// directories included) and app.ts with the TypeScript parser. It reads
// app.<verb>(path, ...), app.all(path, ...) and app.route({ method, url }) on
// any Fastify instance name, resolves a path held in a const (the declaration
// in scope at the call: the same name may be declared in several functions)
// or in an object property of the same file, and turns a template literal
// segment into '*'. A registration it cannot resolve, a route() without a
// literal method and url, a nested register() prefix, and a verb call shaped
// like a route (a path and a handler function) on a receiver that is not a
// known Fastify instance fail the guard instead of being skipped.

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLEET_SCOPE_ROUTES,
  SITE_ISOLATION_ALLOWLIST,
  SITE_ISOLATION_MATRIX,
} from './helpers/site-isolation-matrix.js';
import { ALL_METHODS, scanRoutes, scanSource, type ScanResult } from './helpers/route-scan.js';

const key = (e: { method: string; path: string }): string => `${e.method} ${e.path}`;

describe('site isolation coverage', () => {
  const { routes, portal, unparsed, fleetScope } = scanRoutes();
  const matrix = new Set(SITE_ISOLATION_MATRIX.map(key));
  const allowlist = new Set(SITE_ISOLATION_ALLOWLIST.map(key));

  it('finds the operator routes', () => {
    // About 515 today: a scanner that stops matching fails here instead of passing empty.
    expect(routes.length).toBeGreaterThan(450);
    expect(routes).toContain('POST /ocpp/commands/*/*');
    expect(routes).toContain('POST /css/actions/*');
    expect(routes).toContain('GET /stations/:id/neighbors');
    expect(routes).toContain('GET /v1/health');
    expect(portal.length).toBeGreaterThan(50);
  });

  it('parses every route registration', () => {
    expect(unparsed).toEqual([]);
  });

  it('classifies every operator route: in the matrix or allowlisted with a reason', () => {
    const unclassified = routes.filter((r) => !matrix.has(r) && !allowlist.has(r));
    expect(unclassified).toEqual([]);
  });

  it('lists no route twice and no route that does not exist', () => {
    const known = new Set(routes);
    const stale = [...matrix, ...allowlist].filter((r) => !known.has(r));
    expect(stale).toEqual([]);
    expect([...matrix].filter((r) => allowlist.has(r))).toEqual([]);
    expect(SITE_ISOLATION_MATRIX.length + SITE_ISOLATION_ALLOWLIST.length).toBe(
      matrix.size + allowlist.size,
    );
  });

  it('gives every allowlisted route a reason', () => {
    expect(SITE_ISOLATION_ALLOWLIST.filter((e) => e.reason.trim().length < 8)).toEqual([]);
  });

  it('declares the refusal code of every scoped and company entry', () => {
    const missing = SITE_ISOLATION_MATRIX.filter(
      (e) =>
        e.kind !== 'list' &&
        e.expectCode.trim().length === 0 &&
        // An entry checked by text still checks the actor without a site:
        // by its own text, or else by the code.
        (e.kind === 'company' || e.expectText == null || e.noSitesText == null),
    ).map(key);
    expect(missing).toEqual([]);
  });

  it('lists exactly the routes open to fleet users, each with a fleet check', () => {
    const declared = new Set(fleetScope ?? []);
    const listed = FLEET_SCOPE_ROUTES.map(key);
    // A route opened to fleet users without an entry, or an entry for a route
    // that does not open itself to them.
    expect([...declared].filter((r) => !listed.includes(r))).toEqual([]);
    expect(listed.filter((r) => !declared.has(r))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    // The fleet routes and the own API key routes: a scanner that stops finding the flag fails here.
    expect(declared.size).toBe(30);
    // Every route that names a resource checks another fleet's or an unreadable one.
    const unchecked = FLEET_SCOPE_ROUTES.filter(
      (e) => e.path.includes(':') && e.other.length === 0,
    ).map(key);
    expect(unchecked).toEqual([]);
  });

  it('gives every control that cannot succeed its expected code and reason', () => {
    const vague = SITE_ISOLATION_MATRIX.filter(
      (e) =>
        e.kind !== 'list' &&
        e.control?.status != null &&
        (e.control.status < 200 || e.control.status > 299) &&
        (e.control.code == null || (e.control.reason ?? '').length < 8),
    ).map(key);
    expect(vague).toEqual([]);
  });
});

describe('route scanner', () => {
  const scan = (rel: string, source: string): ScanResult => {
    const out: ScanResult = { routes: [], portal: [], unparsed: [] };
    const routes = new Set<string>();
    const portal = new Set<string>();
    scanSource(rel, source, out, routes, portal);
    return { ...out, routes: [...routes].sort(), portal: [...portal].sort() };
  };

  it('reads route(), all(), other instance names and resolved paths', () => {
    const result = scan(
      path.join('routes', 'x.ts'),
      `
      const PATH = '/things/:id';
      const TARGETS = [{ path: '/a/:id/neighbors' }, { path: '/b/:id/neighbors' }];
      export function routes(server: FastifyInstance) {
        server.get('/things', handler);
        app.route({ method: ['PUT', 'patch'], url: '/routed/:id', handler });
        app.all('/everything', handler);
        app.delete(PATH, handler);
        app.post(\`/commands/\${version}/\${name}\`, handler);
        for (const target of TARGETS) app.get(target.path, handler);
        app.register(async (scope) => { scope.post('/scoped', handler); });
        map.get(key);
      }`,
    );
    expect(result.unparsed).toEqual([]);
    expect(result.routes).toEqual(
      [
        'GET /things',
        'PUT /routed/:id',
        'PATCH /routed/:id',
        ...ALL_METHODS.map((m) => `${m} /everything`),
        'DELETE /things/:id',
        'POST /commands/*/*',
        'GET /a/:id/neighbors',
        'GET /b/:id/neighbors',
        'POST /scoped',
      ].sort(),
    );
  });

  it('fails on a path, a route() or a prefix it cannot resolve', () => {
    const result = scan(
      path.join('routes', 'nested', 'y.ts'),
      `
      export function routes(app: FastifyInstance) {
        app.get(buildPath(), handler);
        app.post(BASE + '/x', handler);
        app.route(options);
        app.route({ method: verb, url: '/x', handler });
        app.register(child, { prefix: '/child' });
      }`,
    );
    expect(result.routes).toEqual([]);
    expect(result.unparsed).toHaveLength(5);
  });

  it('resolves a const name declared in several functions by the declaration in scope', () => {
    const result = scan(
      path.join('routes', 'w.ts'),
      `
      const ROUTE = '/top';
      export function first(app: FastifyInstance) {
        const ROUTE = '/first/:id';
        app.get(ROUTE, handler);
      }
      export function second(app: FastifyInstance) {
        const ROUTE = '/second/:id';
        app.delete(ROUTE, handler);
        if (flag) {
          const ROUTE = '/inner';
          app.post(ROUTE, handler);
        }
        app.patch(ROUTE, handler);
      }
      export function third(app: FastifyInstance) {
        app.put(ROUTE, handler);
      }
      export function fourth(app: FastifyInstance, ROUTE: string) {
        app.get(ROUTE, handler);
      }`,
    );
    expect(result.routes).toEqual(
      [
        'GET /first/:id',
        'DELETE /second/:id',
        'POST /inner',
        'PATCH /second/:id',
        'PUT /top',
      ].sort(),
    );
    // A parameter shadows the file const: its value is unknown.
    expect(result.unparsed).toHaveLength(1);
  });

  it('fails on a route-shaped verb call on a receiver that is not a Fastify instance', () => {
    const result = scan(
      path.join('routes', 'v.ts'),
      `
      export function routes(server) {
        server.get('/untyped', async () => ({}));
        router.post(PATH, function handler() {});
        cache.get(key);
        searchParams.delete('x');
      }`,
    );
    expect(result.routes).toEqual([]);
    expect(result.unparsed).toHaveLength(2);
  });

  it('reads the routes whose options open them to fleet users', () => {
    const out: ScanResult = { routes: [], portal: [], unparsed: [] };
    const fleetScope = new Set<string>();
    scanSource(
      path.join('routes', 'f.ts'),
      `
      const TARGETS = [
        { path: '/open/:id/neighbors', fleetScopeWhere: (ids) => ids },
        { path: '/closed/:id/neighbors' },
      ];
      export function routes(app: FastifyInstance) {
        app.get('/plain', { onRequest: [x] }, async () => ({}));
        app.get('/open', { config: { fleetScope: true } }, async () => ({}));
        app.post('/open-rate', { config: { fleetScope: true, rateLimit: { max: 1 } } }, async () => ({}));
        app.get('/false', { config: { fleetScope: false } }, async () => ({}));
        app.route({ method: 'PUT', url: '/routed', config: { fleetScope: true }, handler });
        for (const target of TARGETS) {
          app.get(
            target.path,
            { ...(target.fleetScopeWhere != null ? { config: { fleetScope: true } } : {}) },
            async () => target.fleetScopeWhere,
          );
        }
        app.get('/odd', { config: SHARED, fleetScope: true }, async () => ({}));
        app.get('/indirect', fleetScopeOptions, async () => ({}));
      }`,
      out,
      new Set(),
      new Set(),
      undefined,
      fleetScope,
    );
    expect([...fleetScope].sort()).toEqual(
      ['GET /open', 'POST /open-rate', 'PUT /routed', 'GET /open/:id/neighbors'].sort(),
    );
    // A mention the scanner cannot read (false, a variable, a misplaced flag) fails instead of passing as closed.
    expect(out.unparsed).toHaveLength(3);
  });

  it('keeps driver portal routes apart, but not an operator path in the portal folder', () => {
    const result = scan(
      path.join('routes', 'portal', 'z.ts'),
      `app.get('/portal/chargers/:id', h); app.get('/operator-thing', h);`,
    );
    expect(result.portal).toEqual(['GET /portal/chargers/:id']);
    expect(result.routes).toEqual(['GET /operator-thing']);
  });
});
