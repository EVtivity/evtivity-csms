// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import Handlebars from 'handlebars';
import { describe, it, expect } from 'vitest';
import {
  assertTemplateAllowed,
  compileAllowedTemplate,
  TemplateNotAllowedError,
} from '../template-safety.js';

describe('assertTemplateAllowed', () => {
  it.each([
    'Hello {{firstName}}',
    '{{{content}}}',
    '{{! a comment }}Hi',
    '{{#if firstName}}Hi {{firstName}},{{else}}Hello,{{/if}}',
    '{{#unless reason}}No reason{{/unless}}',
    '{{#if a}}A{{else if b}}B{{else}}C{{/if}}',
    '{{#if a}}{{#if b}}nested{{/if}}{{/if}}',
    '{{this}} {{a.b}} {{items.[0]}}',
  ])('allows %s', (source) => {
    expect(() => {
      assertTemplateAllowed(source);
    }).not.toThrow();
  });

  it.each([
    ['{{#each items}}x{{/each}}', 'Only {{#if}} and {{#unless}} block helpers'],
    ['{{#with a}}x{{/with}}', 'Only {{#if}} and {{#unless}} block helpers'],
    ['{{> header}}', 'Partials are not allowed'],
    ['{{#> layout}}x{{/layout}}', 'Partials are not allowed'],
    ['{{lookup a b}}', 'Helpers are not allowed'],
    ['{{log a}}', 'Helpers are not allowed'],
    ['{{name key=value}}', 'Helpers are not allowed'],
    ['{{#if (eq a b)}}x{{/if}}', 'Only variables are allowed'],
    ['{{#if a b}}x{{/if}}', 'takes exactly one variable'],
    ['{{#if a key=1}}x{{/if}}', 'takes exactly one variable'],
    [
      '{{#if a}}x{{else}}{{#each b}}y{{/each}}{{/if}}',
      'Only {{#if}} and {{#unless}} block helpers',
    ],
    ['{{a.constructor}}', '"constructor" is not allowed'],
    ['{{__proto__}}', '"__proto__" is not allowed'],
    ['{{"literal"}}', 'Only variables are allowed'],
    ['{{../companyName}}', '"../companyName" is not allowed'],
    ['{{@root.companyName}}', '"@root.companyName" is not allowed'],
  ])('rejects %s', (source, message) => {
    expect(() => {
      assertTemplateAllowed(source);
    }).toThrow(TemplateNotAllowedError);
    expect(() => {
      assertTemplateAllowed(source);
    }).toThrow(message);
  });

  it('throws the parse error for invalid syntax', () => {
    expect(() => {
      assertTemplateAllowed('{{#if a}}unclosed');
    }).toThrow(/Parse error|doesn't match|Expecting/);
  });
});

describe('compileAllowedTemplate', () => {
  it('renders if/else blocks', () => {
    const render = compileAllowedTemplate('{{#if firstName}}Hi {{firstName}}{{else}}Hello{{/if}}');
    expect(render({ firstName: 'Ann' })).toBe('Hi Ann');
    expect(render({})).toBe('Hello');
  });

  it('escapes {{var}} and leaves {{{var}}} raw', () => {
    const render = compileAllowedTemplate('{{v}}|{{{v}}}');
    expect(render({ v: '<b>&"</b>' })).toBe('&lt;b&gt;&amp;&quot;&lt;/b&gt;|<b>&"</b>');
  });

  it('never reads inherited properties', () => {
    const render = compileAllowedTemplate('[{{toString}}][{{a.hasOwnProperty}}]');
    expect(render({ a: {} })).toBe('[][]');
  });

  it('rejects before rendering', () => {
    expect(() => compileAllowedTemplate('{{#each a}}x{{/each}}')).toThrow(TemplateNotAllowedError);
  });

  // The renderer replaces Handlebars.compile for operator templates, so its
  // output must match Handlebars for every construct it allows.
  it.each([
    ['{{#if a}}A{{else if b}}B{{else}}C{{/if}}', { b: 1 }],
    ['{{#unless a}}none{{else}}some{{/unless}}', { a: [] }],
    ['{{#if n}}yes{{else}}no{{/if}} {{n}} {{f}} {{t}}', { n: 0, f: false, t: true }],
    [
      '{{list}} {{obj}} {{missing}} {{nested.x.y}}',
      { list: [1, 'a'], obj: {}, nested: { x: { y: 3 } } },
    ],
    ['  {{#if a}}\n  line\n  {{/if}}\n{{~v~}}  end', { a: true, v: 'V' }],
    ['{{! comment }}{{{html}}}{{html}}', { html: "<i>'x'</i>" }],
  ])('matches Handlebars for %s', (source, variables) => {
    expect(compileAllowedTemplate(source)(variables)).toBe(Handlebars.compile(source)(variables));
  });
});
