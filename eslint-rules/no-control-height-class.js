// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Control heights come from the shared components, never from a className
 * (`frontend/ui.md`, control heights). Inputs, selects and buttons have one
 * height per app, so a height or vertical padding class on one of them makes it
 * stand out from the controls next to it. The rule refuses `h-*`, `min-h-*`,
 * `max-h-*`, `size-*` and vertical padding (`py-*`, `pt-*`, `pb-*`), with any
 * variant prefix and arbitrary values, in the className of the shared controls,
 * of every `*Button` component and of `buttonVariants(...)`. Layout classes
 * (width, flex, margin, position) stay allowed. Enabled for the CSMS and portal
 * sources outside `components/ui`.
 */
const CONTROLS = new Set([
  'Input',
  'ClearableInput',
  'PasswordInput',
  'DecimalInput',
  'Select',
  'SearchInput',
  'Combobox',
  'MonthPicker',
  'LanguageSelect',
]);

const HEIGHT_CLASS = /^(?:h|min-h|max-h|size|py|pt|pb)-/;

/** Strips variant prefixes (`sm:`, `[&>svg]:`) and the important marker. */
function utilityOf(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    else if (ch === ':' && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!/, '').replace(/!$/, '').replace(/^-/, '');
}

/** A variant that styles the children (`[&>svg]:h-4`, `*:h-4`), not the control itself. */
function targetsChildren(token) {
  return /(?:^|:)(?:\*|\[&[^\]]*\])+:/.test(token) || token.startsWith('*:');
}

/** The height classes in a string of classes. */
export function heightClasses(text) {
  return text
    .split(/\s+/)
    .filter(
      (token) => token !== '' && !targetsChildren(token) && HEIGHT_CLASS.test(utilityOf(token)),
    );
}

/** Every string literal that can end up in a class list. */
function classStrings(node, out) {
  if (node == null) return;
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') out.push({ node, text: node.value });
      break;
    case 'TemplateLiteral':
      for (const quasi of node.quasis) out.push({ node, text: quasi.value.cooked ?? '' });
      for (const expr of node.expressions) classStrings(expr, out);
      break;
    case 'JSXExpressionContainer':
      classStrings(node.expression, out);
      break;
    case 'ConditionalExpression':
      classStrings(node.consequent, out);
      classStrings(node.alternate, out);
      break;
    case 'LogicalExpression':
      classStrings(node.right, out);
      if (node.operator !== '&&') classStrings(node.left, out);
      break;
    case 'ArrayExpression':
      for (const el of node.elements) classStrings(el, out);
      break;
    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (prop.type === 'Property') classStrings(prop.key, out);
      }
      break;
    case 'CallExpression':
      // cn(...), clsx(...); a nested buttonVariants call is checked on its own.
      if (!isButtonVariants(node)) for (const arg of node.arguments) classStrings(arg, out);
      break;
    default:
      break;
  }
}

function isButtonVariants(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'buttonVariants'
  );
}

function elementName(node) {
  if (node.type === 'JSXIdentifier') return node.name;
  if (node.type === 'JSXMemberExpression') return node.property.name;
  return null;
}

function isControl(name) {
  return name != null && (CONTROLS.has(name) || /Button$/.test(name));
}

export const noControlHeightClass = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Inputs, selects and buttons take their height from the shared component.',
    },
    schema: [],
    messages: {
      heightClass:
        '"{{classes}}" sets the height of {{control}}. Keep the shared height, or use a documented Button size, instead of a height or vertical padding class.',
    },
  },
  create(context) {
    function check(node, control) {
      const strings = [];
      classStrings(node, strings);
      for (const { node: at, text } of strings) {
        const found = heightClasses(text);
        if (found.length > 0) {
          context.report({
            node: at,
            messageId: 'heightClass',
            data: { classes: found.join(' '), control },
          });
        }
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'className') return;
        const name = elementName(node.parent.name);
        if (isControl(name)) check(node.value, name);
      },
      CallExpression(node) {
        if (isButtonVariants(node)) {
          const [options] = node.arguments;
          if (options?.type !== 'ObjectExpression') return;
          for (const prop of options.properties) {
            if (
              prop.type === 'Property' &&
              prop.key.type === 'Identifier' &&
              prop.key.name === 'className'
            ) {
              check(prop.value, 'buttonVariants');
            }
          }
          return;
        }
        // cn(buttonVariants(...), 'h-8'): the other arguments style the same element.
        if (node.arguments.some((arg) => isButtonVariants(arg))) {
          for (const arg of node.arguments) {
            if (!isButtonVariants(arg)) check(arg, 'buttonVariants');
          }
        }
      },
    };
  },
};
