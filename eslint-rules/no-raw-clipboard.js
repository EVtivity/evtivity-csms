// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Copying goes through the shared copy controls (`CopyButton`, `IdText`,
 * `CopyableId`) or the `copyText` helper in `components/ui/clipboard.ts`,
 * never `navigator.clipboard` directly, so every copy shows the same Copied
 * feedback and works on plain HTTP origins. Enabled for the CSMS and portal
 * sources outside `components/ui`.
 */
function propertyName(node) {
  if (node.computed) {
    if (node.property.type === 'Literal') return node.property.value;
    if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0) {
      return node.property.quasis[0]?.value.cooked;
    }
    return null;
  }
  return node.property.type === 'Identifier' ? node.property.name : null;
}

/** `navigator`, `window.navigator`, `globalThis.navigator`, `self.navigator`. */
function isNavigator(node) {
  if (node.type === 'Identifier') return node.name === 'navigator';
  if (node.type === 'MemberExpression') return propertyName(node) === 'navigator';
  return false;
}

export const noRawClipboard = {
  meta: {
    type: 'problem',
    docs: { description: 'Use the shared copy controls instead of navigator.clipboard.' },
    schema: [],
    messages: {
      rawClipboard:
        'Use the shared CopyButton, IdText or CopyableId, or copyText from @/components/ui/clipboard, instead of navigator.clipboard.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (propertyName(node) === 'clipboard' && isNavigator(node.object)) {
          context.report({ node, messageId: 'rawClipboard' });
        }
      },
    };
  },
};
