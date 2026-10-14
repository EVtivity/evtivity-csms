// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Route scanner shared by the coverage guards (site-isolation-coverage.test.ts,
// audit-coverage.test.ts). It parses every source file under routes/ and
// plugins/ (nested directories included) and app.ts with the TypeScript
// parser. It reads app.<verb>(path, ...), app.all(path, ...) and
// app.route({ method, url }) on any Fastify instance name, resolves a path
// held in a const (the declaration in scope at the call: the same name may be
// declared in several functions) or in an object property of the same file,
// and turns a template literal segment into '*'. A registration it cannot
// resolve, a route() without a literal method and url, a nested register()
// prefix, and a verb call shaped like a route (a path and a handler function)
// on a receiver that is not a known Fastify instance are reported as unparsed
// instead of being skipped.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
export const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

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

/** One route registration: the file under src/ and the source text of the call. */
export interface RouteRegistration {
  file: string;
  text: string;
}

/** Scans one file's source. `rel` is its path under src/ (routes/portal/* are driver routes). */
export function scanSource(
  rel: string,
  source: string,
  out: ScanResult,
  routes: Set<string>,
  portal: Set<string>,
  registrations?: Map<string, RouteRegistration[]>,
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

  const add = (methods: string[], paths: string[], call: ts.Node): void => {
    for (const p of paths) {
      for (const method of methods) {
        const key = `${method} ${p}`;
        if (registrations != null) {
          const text = call.getText(sf);
          registrations.set(key, [...(registrations.get(key) ?? []), { file: rel, text }]);
        }
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
            add(methods, paths, node);
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
          add(methods, paths, node);
        } else if (onInstance) {
          out.unparsed.push(where(node));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/**
 * Scans every route file. `registrations`, when given, receives the source
 * text of each registration by `METHOD /path` (operator and portal keys).
 */
export function scanRoutes(registrations?: Map<string, RouteRegistration[]>): ScanResult {
  const out: ScanResult = { routes: [], portal: [], unparsed: [] };
  const routes = new Set<string>();
  const portal = new Set<string>();
  for (const file of routeFiles()) {
    scanSource(
      path.relative(SRC, file),
      readFileSync(file, 'utf8'),
      out,
      routes,
      portal,
      registrations,
    );
  }
  out.routes = [...routes].sort();
  out.portal = [...portal].sort();
  return out;
}
