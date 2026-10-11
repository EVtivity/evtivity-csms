// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A switch is the shared `Toggle` (`components/ui/toggle.tsx`), never a
 * hand-rolled `role="switch"` element (`frontend/ui.md`, shared controls).
 * Enabled for the CSMS and portal sources outside `components/ui`.
 */
function isSwitchValue(value) {
  if (value == null) return false;
  if (value.type === 'Literal') return value.value === 'switch';
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    if (expr.type === 'Literal') return expr.value === 'switch';
    if (expr.type === 'TemplateLiteral') {
      return expr.expressions.length === 0 && expr.quasis[0]?.value.cooked === 'switch';
    }
  }
  return false;
}

export const noRawSwitch = {
  meta: {
    type: 'problem',
    docs: { description: 'Use the shared Toggle instead of a role="switch" element.' },
    schema: [],
    messages: {
      rawSwitch:
        'Use the shared Toggle from @/components/ui/toggle instead of a role="switch" element.',
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type === 'JSXIdentifier' && node.name.name === 'role') {
          if (isSwitchValue(node.value)) context.report({ node, messageId: 'rawSwitch' });
        }
      },
    };
  },
};
