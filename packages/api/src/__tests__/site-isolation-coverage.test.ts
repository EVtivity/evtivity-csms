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

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  SITE_ISOLATION_ALLOWLIST,
  SITE_ISOLATION_MATRIX,
} from './helpers/site-isolation-matrix.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Operator route files: routes/** (driver portal routes are reported apart), plugins/**, app.ts. */
function routeFiles(): string[] {
  return [
    ...sourceFiles(path.join(SRC, 'routes')),
    ...sourceFiles(path.join(SRC, 'plugins')),
    path.join(SRC, 'app.ts'),
  ];
}

/** A template literal segment `${...}` becomes '*': one matrix entry covers the family. */
function normalize(p: string): string {
  return p.replace(/\*+/g, '*');
}

export interface ScanResult {
  /** Operator routes, `METHOD /path`. */
  routes: string[];
  /** Driver portal routes (routes/portal/**), all under /portal/. */
  portal: string[];
  /** Registrations the scanner cannot resolve, `file:line text`. */
  unparsed: string[];
}

/** Scans one file's source. `rel` is its path under src/ (routes/portal/* are driver routes). */
export function scanSource(
  rel: string,
  source: string,
  out: ScanResult,
  routes: Set<string>,
  portal: Set<string>,
): void {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const inPortal = rel.startsWith(`routes${path.sep}portal${path.sep}`);

  // Every variable and parameter declaration by name, with its scope and
  // position (value: the literal path, else null), and every `prop: '/path'`.
  const declarations = new Map<string, { scope: ts.Node; pos: number; value: string | null }[]>();
  const props = new Map<string, string[]>();
  const isScope = (node: ts.Node): boolean =>
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node);
  const scopeOf = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (!isScope(current)) current = current.parent;
    return current;
  };
  const declare = (name: string, scope: ts.Node, pos: number, value: string | null): void => {
    declarations.set(name, [...(declarations.get(name) ?? []), { scope, pos, value }]);
  };
  // Fastify instance names: `app`, parameters typed FastifyInstance and register() callbacks.
  const instances = new Set<string>(['app']);

  const literal = (node: ts.Node | undefined): string | null => {
    if (node == null) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return normalize(
        node.head.text + node.templateSpans.map((span) => `*${span.literal.text}`).join(''),
      );
    }
    return null;
  };

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      // A const without a literal path still shadows an outer one.
      declare(node.name.text, scopeOf(node), node.getStart(sf), literal(node.initializer));
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declare(node.name.text, node.parent, node.getStart(sf), null);
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const value = literal(node.initializer);
      if (value?.startsWith('/') === true) {
        props.set(node.name.text, [...(props.get(node.name.text) ?? []), value]);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      if (node.type?.getText(sf).includes('FastifyInstance') === true) {
        instances.add(node.name.text);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'register'
    ) {
      const plugin = node.arguments[0];
      if (plugin != null && (ts.isArrowFunction(plugin) || ts.isFunctionExpression(plugin))) {
        const first = plugin.parameters[0];
        if (first != null && ts.isIdentifier(first.name)) instances.add(first.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  // The declaration in scope at `node`: the innermost enclosing scope that
  // declares the name, the last declaration there before the use (a closure
  // may use one declared later in its outer scope).
  const lookup = (node: ts.Identifier): string | null => {
    const candidates = declarations.get(node.text) ?? [];
    const use = node.getStart(sf);
    for (let scope: ts.Node = node.parent; ; scope = scope.parent) {
      const here = candidates.filter((d) => d.scope === scope);
      if (here.length > 0) {
        const before = here.filter((d) => d.pos < use);
        return (before.at(-1) ?? here[0])?.value ?? null;
      }
      if (ts.isSourceFile(scope)) return null;
    }
  };

  const resolve = (node: ts.Node | undefined): string[] | null => {
    if (node == null) return null;
    const value = literal(node);
    if (value != null) return [value];
    if (ts.isIdentifier(node)) {
      const found = lookup(node);
      return found != null ? [found] : null;
    }
    if (ts.isPropertyAccessExpression(node)) return props.get(node.name.text) ?? null;
    return null;
  };

  const where = (node: ts.Node): string => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${rel}:${String(line + 1)} ${node.getText(sf).split('\n')[0] ?? ''}`;
  };

  const add = (methods: string[], paths: string[]): void => {
    for (const p of paths) {
      for (const method of methods) {
        const key = `${method} ${p}`;
        if (inPortal && p.startsWith('/portal/')) portal.add(key);
        else routes.add(key);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const receiver = node.expression.expression;
      const onInstance = ts.isIdentifier(receiver) && instances.has(receiver.text);
      const arg = node.arguments[0];

      if (name === 'register' && onInstance) {
        // A nested prefix changes every path below it: only app.ts's /v1 is known.
        const options = node.arguments[1];
        if (options != null && ts.isObjectLiteralExpression(options)) {
          for (const prop of options.properties) {
            if (prop.name?.getText(sf) !== 'prefix') continue;
            const prefix = ts.isPropertyAssignment(prop) ? literal(prop.initializer) : null;
            if (!(rel === 'app.ts' && prefix === '/v1')) out.unparsed.push(where(node));
          }
        }
      } else if (name === 'route') {
        const isOptions = arg != null && ts.isObjectLiteralExpression(arg);
        if (onInstance || isOptions) {
          let methods: string[] | null = null;
          let paths: string[] | null = null;
          if (arg != null && ts.isObjectLiteralExpression(arg)) {
            for (const prop of arg.properties) {
              if (!ts.isPropertyAssignment(prop)) continue;
              const key = prop.name.getText(sf);
              if (key === 'method') {
                const init = prop.initializer;
                const single = literal(init);
                if (single != null) methods = [single.toUpperCase()];
                else if (ts.isArrayLiteralExpression(init)) {
                  const all = init.elements.map((e) => literal(e));
                  methods = all.every((m) => m != null) ? all.map((m) => m.toUpperCase()) : null;
                }
              }
              if (key === 'url' || key === 'path') paths = resolve(prop.initializer);
            }
          }
          if (methods != null && paths?.every((p) => p.startsWith('/')) === true) {
            add(methods, paths);
          } else {
            out.unparsed.push(where(node));
          }
        }
      } else if (VERBS.has(name)) {
        const paths = resolve(arg);
        const methods = name === 'all' ? ALL_METHODS : [name.toUpperCase()];
        // A path and a handler function: the shape of a route registration.
        const handler = node.arguments.at(-1);
        const routeShaped =
          node.arguments.length >= 2 &&
          handler != null &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler));
        if (routeShaped && !onInstance) {
          // A route on a receiver the scanner does not know as a Fastify
          // instance: type the parameter FastifyInstance so it is read.
          out.unparsed.push(where(node));
        } else if (paths?.every((p) => p.startsWith('/')) === true) {
          add(methods, paths);
        } else if (onInstance) {
          out.unparsed.push(where(node));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

export function scanRoutes(): ScanResult {
  const out: ScanResult = { routes: [], portal: [], unparsed: [] };
  const routes = new Set<string>();
  const portal = new Set<string>();
  for (const file of routeFiles()) {
    scanSource(path.relative(SRC, file), readFileSync(file, 'utf8'), out, routes, portal);
  }
  out.routes = [...routes].sort();
  out.portal = [...portal].sort();
  return out;
}

const key = (e: { method: string; path: string }): string => `${e.method} ${e.path}`;

describe('site isolation coverage', () => {
  const { routes, portal, unparsed } = scanRoutes();
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

  it('keeps driver portal routes apart, but not an operator path in the portal folder', () => {
    const result = scan(
      path.join('routes', 'portal', 'z.ts'),
      `app.get('/portal/chargers/:id', h); app.get('/operator-thing', h);`,
    );
    expect(result.portal).toEqual(['GET /portal/chargers/:id']);
    expect(result.routes).toEqual(['GET /operator-thing']);
  });
});
