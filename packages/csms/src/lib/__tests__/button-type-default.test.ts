// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { describe, it, expect } from 'vitest';
import ts from 'typescript';

/**
 * An HTML button without a `type` is a submit button. A shared action button
 * (Edit, Add, Refresh, ...) rendered inside a form, directly or through a
 * child component such as the avatar editor in a user edit form, then submits
 * that form on click. Every exported `*Button` component of the CSMS and the
 * portal gives each `Button` it renders an explicit type: `"button"`, or a
 * `type` prop whose default is `'button'`. Forms submit through `SaveButton`
 * or a `Button type="submit"` (`frontend/testability.md`, "Form Submission").
 */

const CSMS_SOURCES = import.meta.glob<string>(['../../components/**/*.tsx', '!**/__tests__/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const PORTAL_SOURCES = import.meta.glob<string>(
  ['../../../../portal/src/components/**/*.tsx', '!**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
);

/** Components that are submit buttons by design, with the reason. */
const SUBMIT_BY_DEFAULT: Record<string, string> = {
  SaveButton: 'the submit button of every edit and create form (frontend/testability.md)',
};

const BUTTON_TAGS = new Set(['Button', 'button']);

/** The default a destructured parameter gives `name`, as source text, or null when it has none. */
function parameterDefault(fn: ts.FunctionDeclaration, name: string): string | null {
  for (const param of fn.parameters) {
    if (!ts.isObjectBindingPattern(param.name)) continue;
    for (const element of param.name.elements) {
      if (element.name.getText() === name && element.initializer !== undefined) {
        return element.initializer.getText();
      }
    }
  }
  return null;
}

/** Each `Button` a shared button component renders without a type default of 'button'. */
function untypedButtons(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const checkFunction = (fn: ts.FunctionDeclaration): void => {
    const name = fn.name?.getText() ?? '';
    const expected = name in SUBMIT_BY_DEFAULT ? "'submit'" : "'button'";
    const visit = (node: ts.Node): void => {
      const tag = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;
      if (tag !== null && BUTTON_TAGS.has(tag.tagName.getText())) {
        const line = sf.getLineAndCharacterOfPosition(tag.getStart()).line + 1;
        const where = `${file}:${String(line)} ${name}`;
        const typeAttr = tag.attributes.properties.find(
          (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'type',
        );
        const init = typeAttr?.initializer;
        if (init === undefined) {
          problems.push(`${where}: no type`);
        } else if (ts.isStringLiteral(init)) {
          if (init.text === 'submit' && !(name in SUBMIT_BY_DEFAULT)) {
            problems.push(`${where}: type="submit"`);
          }
        } else if (
          ts.isJsxExpression(init) &&
          init.expression !== undefined &&
          ts.isIdentifier(init.expression)
        ) {
          const fallback = parameterDefault(fn, init.expression.text);
          if (fallback?.replace(/"/g, "'") !== expected) {
            problems.push(`${where}: type defaults to ${fallback ?? 'nothing'}`);
          }
        } else {
          problems.push(`${where}: type is not a literal or a defaulted prop`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
  };
  for (const statement of sf.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      /Button$/.test(statement.name.text) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    ) {
      checkFunction(statement);
    }
  }
  return problems;
}

function scan(sources: Record<string, string>): { problems: string[]; components: number } {
  const problems: string[] = [];
  let components = 0;
  for (const [file, source] of Object.entries(sources)) {
    const count = (source.match(/export function \w+Button\b/g) ?? []).length;
    if (count === 0) continue;
    components += count;
    problems.push(...untypedButtons(file, source));
  }
  return { problems, components };
}

describe('shared button type defaults', () => {
  it('gives every CSMS shared button an explicit, non-submit type', () => {
    const { problems, components } = scan(CSMS_SOURCES);
    expect(components).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  it('gives every portal shared button an explicit, non-submit type', () => {
    const { problems, components } = scan(PORTAL_SOURCES);
    expect(components).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('flags a button without a type and a prop that defaults to submit', () => {
    const source = [
      'export function AddButton({ onClick }: P) { return <Button onClick={onClick}>Add</Button>; }',
      "export function SendButton({ type = 'submit' }: P) { return <Button type={type}>Send</Button>; }",
      "export function SaveButton({ type = 'submit' }: P) { return <Button type={type}>Save</Button>; }",
      "export function EditButton({ type = 'button' }: P) { return <Button type={type}>Edit</Button>; }",
    ].join('\n');
    const problems = untypedButtons('sample.tsx', source);
    expect(problems).toEqual([
      'sample.tsx:1 AddButton: no type',
      "sample.tsx:2 SendButton: type defaults to 'submit'",
    ]);
  });
});
