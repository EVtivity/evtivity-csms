// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The source scans of the load management record guards, run as a child process
// so coverage instrumentation of the TypeScript compiler does not slow them
// down. Reads one JSON request on argv and prints the matches as JSON.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';

interface ScanRequest {
  root: string;
  scan: 'valueReads' | 'names';
  recordTypes?: string[];
  owners?: string[];
  valueFields?: string[];
  names?: string[];
  rawNames?: string[];
}

interface NameUse {
  name: string;
  line: number;
}

const request = JSON.parse(process.argv[2] ?? '{}') as ScanRequest;
const ROOT = request.root;

function topLevelName(node: ts.Node): string {
  let n: ts.Node = node;
  while (!ts.isSourceFile(n.parent)) n = n.parent;
  if (ts.isFunctionDeclaration(n) && n.name != null) return n.name.text;
  if (ts.isVariableStatement(n)) return n.declarationList.declarations[0]?.name.getText() ?? '?';
  if ((ts.isInterfaceDeclaration(n) || ts.isClassDeclaration(n)) && n.name != null) {
    return n.name.text;
  }
  return '?';
}

function recordTypeName(
  checker: ts.TypeChecker,
  node: ts.Node,
  recordTypes: ReadonlySet<string>,
): string | null {
  const type = checker.getNonNullableType(checker.getTypeAtLocation(node));
  for (const part of type.isUnion() ? type.types : [type]) {
    const name = (part.aliasSymbol ?? part.getSymbol())?.escapedName;
    if (name != null && recordTypes.has(String(name))) return String(name);
  }
  return null;
}

/** Every read of a value field of a record type in the services source. */
function valueReads(): string[] {
  const recordTypes = new Set(request.recordTypes ?? []);
  const owners = new Set(request.owners ?? []);
  const fields = new Set(request.valueFields ?? []);
  const configPath = join(ROOT, 'packages/services/tsconfig.json');
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, (path) => ts.sys.readFile(path)).config,
    ts.sys,
    dirname(configPath),
  );
  const program = ts.createProgram({
    rootNames: config.fileNames.filter((f) => !f.includes('__tests__')),
    options: { ...config.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const reads: string[] = [];
  for (const file of program.getSourceFiles()) {
    const rel = relative(ROOT, file.fileName).split('\\').join('/');
    if (!rel.startsWith('packages/services/src/') || owners.has(rel)) continue;
    if (rel.includes('__tests__')) continue;
    const visit = (node: ts.Node): void => {
      let holder: ts.Node | null = null;
      let field: string | null = null;
      if (ts.isPropertyAccessExpression(node)) {
        holder = node.expression;
        field = node.name.text;
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        holder = node.parent.parent;
        field = (node.propertyName ?? node.name).getText();
      }
      if (holder != null && field != null && fields.has(field)) {
        const type = recordTypeName(checker, holder, recordTypes);
        if (type != null) reads.push(`${rel}#${topLevelName(node)} ${type}.${field}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return reads;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('__')) continue;
    if (name === 'generated' || name === 'e2e') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** The uses of the requested names in the source of every package, by file. */
function nameUses(): Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> {
  const wanted = new Set(request.names ?? []);
  const wantedRaw = new Set(request.rawNames ?? []);
  const files = readdirSync(join(ROOT, 'packages'))
    .map((pkg) => join(ROOT, 'packages', pkg, 'src'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        // fail-open: a package without a src folder holds no source to scan
        return false;
      }
    })
    .flatMap((dir) => sourceFiles(dir));
  const result: Array<{ rel: string; uses: NameUse[]; raw: NameUse[] }> = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const uses: NameUse[] = [];
    const raw: NameUse[] = [];
    const lineOf = (node: ts.Node): number =>
      file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const add = (name: string, node: ts.Node): void => {
      if (wanted.has(name)) uses.push({ name, line: lineOf(node) });
    };
    const visit = (node: ts.Node): void => {
      // A record field read through its holder: `<entry>.limit.state`, `.limit.commandId`.
      if (
        ts.isPropertyAccessExpression(node) &&
        (node.name.text === 'state' || node.name.text === 'commandId') &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'limit'
      ) {
        add(`limit.${node.name.text}`, node.name);
      }
      if (ts.isPropertyAccessExpression(node)) add(node.name.text, node.name);
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
        add(node.argumentExpression.text, node.argumentExpression);
        if (wantedRaw.has(node.argumentExpression.text)) {
          raw.push({ name: node.argumentExpression.text, line: lineOf(node.argumentExpression) });
        }
      } else if (ts.isIdentifier(node) && ts.isCallExpression(node.parent)) {
        if (node.parent.expression === node) add(node.text, node);
      } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        if (ts.isIdentifier(node.name)) add(node.name.text, node.name);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    result.push({ rel: relative(ROOT, path), uses, raw });
  }
  return result;
}

const output = request.scan === 'valueReads' ? valueReads() : nameUses();
process.stdout.write(JSON.stringify(output));
