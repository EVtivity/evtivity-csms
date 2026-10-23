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
  // Parent (../) and data (@) paths need Handlebars context tracking that
  // if/unless blocks never create.
  if (path.depth > 0 || path.data) {
    throw new TemplateNotAllowedError(`"${path.original}" is not allowed in templates`);
  }
  for (const part of path.parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) {
      throw new TemplateNotAllowedError(`"${part}" is not allowed in templates`);
    }
  }
}

/** The `{{{var}}}` names an HTML email template may keep raw, or null when every one may. */
type RawNames = ReadonlySet<string> | null;

function rawNamesOf(options: AllowedTemplateOptions): RawNames {
  return options.rawVariables === undefined ? null : new Set(options.rawVariables);
}

function checkProgram(program: hbs.AST.Program | null | undefined, raw: RawNames): void {
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
        const name = (m.path as hbs.AST.PathExpression).original;
        if (!m.escaped && raw !== null && !raw.has(name)) {
          throw new TemplateNotAllowedError(
            `{{{${name}}}} is not allowed in an HTML email, use {{${name}}}`,
          );
        }
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
        checkProgram(b.program, raw);
        // {{else}} and chained {{else if x}} live in the inverse program.
        checkProgram(b.inverse, raw);
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

/** Renders a template with the given variables. */
export type TemplateRenderer = (variables: Record<string, unknown>) => string;

function parseAllowed(source: string, raw: RawNames = null): hbs.AST.Program {
  const program = Handlebars.parse(source);
  checkProgram(program, raw);
  return program;
}

/**
 * Throws TemplateNotAllowedError unless the template uses only plain
 * variables ({{var}}, {{{var}}}), comments, and {{#if}} / {{#unless}} blocks
 * on a single variable with optional {{else}}. With `rawVariables` (an HTML
 * email), `{{{var}}}` is allowed only for those names. Throws the Handlebars
 * parse error for invalid syntax.
 */
export function assertTemplateAllowed(source: string, options: AllowedTemplateOptions = {}): void {
  parseAllowed(source, rawNamesOf(options));
}

// Own properties only, so a path can never reach the prototype chain.
function lookup(path: hbs.AST.PathExpression, context: unknown): unknown {
  let value = context;
  for (const part of path.parts) {
    if (value == null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

// Same truthiness as the Handlebars if helper: 0, empty strings, and empty
// arrays are false.
function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function toText(value: unknown): string {
  if (Array.isArray(value)) return value.map(toText).join(',');
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return value == null ? '' : '[object Object]';
    default:
      // undefined, functions, and symbols render nothing.
      return '';
  }
}

function renderProgram(
  program: hbs.AST.Program | null | undefined,
  context: unknown,
  noEscape: boolean,
  raw: RawNames,
): string {
  if (program == null) return '';
  let out = '';
  for (const node of program.body) {
    switch (node.type) {
      case 'ContentStatement':
        out += (node as hbs.AST.ContentStatement).value;
        break;
      case 'MustacheStatement': {
        const m = node as hbs.AST.MustacheStatement;
        const path = m.path as hbs.AST.PathExpression;
        const text = toText(lookup(path, context));
        // {{var}} escapes HTML, {{{var}}} does not. Plain-text targets
        // (station displays) escape neither, as Handlebars noEscape does. An
        // HTML email escapes a {{{var}}} saved before the save check too,
        // except the names it may keep raw (the layout's content).
        const escape = m.escaped || (raw !== null && !raw.has(path.original));
        out += escape && !noEscape ? Handlebars.escapeExpression(text) : text;
        break;
      }
      case 'BlockStatement': {
        const b = node as hbs.AST.BlockStatement;
        const condition = isTruthy(lookup(b.params[0] as hbs.AST.PathExpression, context));
        const show = b.path.original === 'unless' ? !condition : condition;
        out += renderProgram(show ? b.program : b.inverse, context, noEscape, raw);
        break;
      }
      default:
        // Comments render nothing. checkProgram rejected everything else.
        break;
    }
  }
  return out;
}

export interface AllowedTemplateOptions {
  /** Render {{var}} without HTML escaping, for plain-text targets (Handlebars `noEscape`). */
  noEscape?: boolean;
  /**
   * An HTML email: only these names may be `{{{var}}}`. A save check refuses
   * any other, and the renderer escapes it like `{{var}}`, so text a driver
   * typed never becomes markup. Unset: every `{{{var}}}` is raw.
   */
  rawVariables?: readonly string[];
}

/** An HTML email body: no raw variable. */
export const EMAIL_BODY_TEMPLATE: AllowedTemplateOptions = { rawVariables: [] };

/** The HTML email layout: only the rendered body, `{{{content}}}`, is raw. */
export const EMAIL_LAYOUT_TEMPLATE: AllowedTemplateOptions = { rawVariables: ['content'] };

function flattenProgram(
  program: hbs.AST.Program | null | undefined,
  placeholder: (name: string) => string,
  names: Set<string>,
): string {
  if (program == null) return '';
  let out = '';
  for (const node of program.body) {
    if (node.type === 'ContentStatement') {
      out += (node as hbs.AST.ContentStatement).value;
    } else if (node.type === 'MustacheStatement') {
      const name = ((node as hbs.AST.MustacheStatement).path as hbs.AST.PathExpression).original;
      names.add(name);
      out += placeholder(name);
    } else if (node.type === 'BlockStatement') {
      const b = node as hbs.AST.BlockStatement;
      out += flattenProgram(b.program, placeholder, names);
      out += flattenProgram(b.inverse, placeholder, names);
    }
  }
  return out;
}

/**
 * Every branch of an allowed template at once: the text of each `{{#if}}` and
 * `{{else}}` part in order, with each `{{var}}` replaced by `placeholder(name)`,
 * plus the names of every variable it uses. A save check reads it to judge
 * every output a template can produce. Throws like `assertTemplateAllowed`.
 */
export function flattenTemplate(
  source: string,
  placeholder: (name: string) => string,
): { text: string; variables: ReadonlySet<string> } {
  const names = new Set<string>();
  const text = flattenProgram(parseAllowed(source), placeholder, names);
  return { text, variables: names };
}

/**
 * Validates an operator-editable template and returns its renderer. The
 * renderer walks the parsed template directly. Operator text is never
 * compiled to JavaScript.
 */
export function compileAllowedTemplate(
  source: string,
  options: AllowedTemplateOptions = {},
): TemplateRenderer {
  const program = parseAllowed(source);
  const noEscape = options.noEscape === true;
  const raw = rawNamesOf(options);
  return (variables) => renderProgram(program, variables, noEscape, raw);
}
