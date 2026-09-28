// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Handlebars from 'handlebars';

/** Block helpers operator-edited templates may use. */
const ALLOWED_BLOCK_HELPERS = new Set(['if', 'unless']);

/** Path segments that reach JavaScript internals instead of template data. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// The Handlebars types declare `hash` as always present, but the parser
// leaves it undefined when a statement has no hash arguments.
function hasHash(node: { hash: hbs.AST.Hash }): boolean {
  return (node.hash as hbs.AST.Hash | undefined) != null;
}

/** A template uses a Handlebars feature operators are not allowed to use. */
export class TemplateNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotAllowedError';
  }
}

function checkPath(node: hbs.AST.Expression): void {
  if (node.type !== 'PathExpression') {
    throw new TemplateNotAllowedError('Only variables are allowed inside {{ }} in templates');
  }
  const path = node as hbs.AST.PathExpression;
  for (const part of path.parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) {
      throw new TemplateNotAllowedError(`"${part}" is not allowed in templates`);
    }
  }
}

function checkProgram(program: hbs.AST.Program | null | undefined): void {
  if (program == null) return;
  for (const node of program.body) {
    switch (node.type) {
      case 'ContentStatement':
      case 'CommentStatement':
        break;
      case 'MustacheStatement': {
        const m = node as hbs.AST.MustacheStatement;
        // {{var}} and {{{var}}} only. Parameters or hash arguments mean a
        // helper call ({{lookup a b}}, {{log x}}).
        if (m.params.length > 0 || hasHash(m)) {
          throw new TemplateNotAllowedError('Helpers are not allowed in templates');
        }
        checkPath(m.path);
        break;
      }
      case 'BlockStatement': {
        const b = node as hbs.AST.BlockStatement;
        const name = b.path.original;
        if (!ALLOWED_BLOCK_HELPERS.has(name)) {
          throw new TemplateNotAllowedError(
            'Only {{#if}} and {{#unless}} block helpers are allowed in templates',
          );
        }
        const [condition] = b.params;
        if (b.params.length !== 1 || condition == null || hasHash(b)) {
          throw new TemplateNotAllowedError(`{{#${name}}} takes exactly one variable`);
        }
        checkPath(condition);
        checkProgram(b.program);
        // {{else}} and chained {{else if x}} live in the inverse program.
        checkProgram(b.inverse);
        break;
      }
      case 'PartialStatement':
      case 'PartialBlockStatement':
        throw new TemplateNotAllowedError('Partials are not allowed in templates');
      default:
        // Decorators and anything a future Handlebars version adds.
        throw new TemplateNotAllowedError(`${node.type} is not allowed in templates`);
    }
  }
}

/**
 * Throws TemplateNotAllowedError unless the template uses only plain
 * variables ({{var}}, {{{var}}}), comments, and {{#if}} / {{#unless}} blocks
 * on a single variable with optional {{else}}. Throws the Handlebars parse
 * error for invalid syntax.
 */
export function assertTemplateAllowed(source: string): void {
  checkProgram(Handlebars.parse(source));
}

/** Validates an operator-editable template, then compiles it. */
export function compileAllowedTemplate(
  source: string,
  options?: CompileOptions,
): HandlebarsTemplateDelegate {
  assertTemplateAllowed(source);
  return Handlebars.compile(source, options);
}
