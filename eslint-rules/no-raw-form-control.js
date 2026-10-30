// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Form controls come from the shared components in `components/ui`
 * (`frontend/ui.md`, shared controls), never a hand-built or native widget:
 *
 * - no raw `<select>` (`Select`, `MonthPicker`, `LanguageSelect`) or
 *   `<textarea>` (`Textarea`);
 * - no raw `<input>` (`Input`, `Checkbox`, `Radio`, `DecimalInput`, ...),
 *   except `type="file"` (the hidden picker behind an upload button),
 *   `type="color"` (no shared color picker) and `type="hidden"`;
 * - no native date-time, time, month or week picker on any element
 *   (`DateTimeInput`, `TimeInput`, `MonthPicker`): each browser draws its own;
 * - no hand-built `role="listbox"`, `role="combobox"` or `role="option"`
 *   (`Combobox`, `SearchCombobox`).
 *
 * Enabled for the CSMS and portal sources outside `components/ui`.
 */
const ALLOWED_INPUT_TYPES = new Set(['file', 'color', 'hidden']);
const NATIVE_PICKER_TYPES = new Map([
  ['datetime-local', 'DateTimeInput'],
  ['time', 'TimeInput'],
  ['month', 'MonthPicker'],
  ['week', 'DateTimeInput'],
]);
const LIST_ROLES = new Set(['listbox', 'combobox', 'option']);

/** The string value of a JSX attribute, or null when it is not a constant. */
function stringValue(value) {
  if (value == null) return null;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
    if (expr.type === 'TemplateLiteral' && expr.expressions.length === 0) {
      return expr.quasis[0]?.value.cooked ?? null;
    }
  }
  return null;
}

function attribute(node, name) {
  return node.attributes.find(
    (a) => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === name,
  );
}

export const noRawFormControl = {
  meta: {
    type: 'problem',
    docs: { description: 'Use the shared form controls instead of raw or native widgets.' },
    schema: [],
    messages: {
      rawSelect: 'Use the shared Select (or MonthPicker, LanguageSelect) instead of <select>.',
      rawTextarea: 'Use the shared Textarea instead of <textarea>.',
      rawInput: 'Use the shared Input, Checkbox, Radio or DecimalInput instead of <input>{{type}}.',
      nativePicker:
        'type="{{type}}" draws a browser-specific picker: use the shared {{component}}.',
      rawList:
        'role="{{role}}" is a hand-built dropdown: use the shared Combobox or SearchCombobox.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
        const typeAttr = attribute(node, 'type');
        const type = typeAttr != null ? stringValue(typeAttr.value) : null;

        if (name === 'select') context.report({ node, messageId: 'rawSelect' });
        else if (name === 'textarea') context.report({ node, messageId: 'rawTextarea' });
        else if (name === 'input' && (type == null || !ALLOWED_INPUT_TYPES.has(type))) {
          context.report({
            node,
            messageId: 'rawInput',
            data: { type: type != null ? ` type="${type}"` : '' },
          });
        }

        if (type != null && NATIVE_PICKER_TYPES.has(type)) {
          context.report({
            node: typeAttr,
            messageId: 'nativePicker',
            data: { type, component: NATIVE_PICKER_TYPES.get(type) },
          });
        }

        const roleAttr = attribute(node, 'role');
        const role = roleAttr != null ? stringValue(roleAttr.value) : null;
        if (role != null && LIST_ROLES.has(role)) {
          context.report({ node: roleAttr, messageId: 'rawList', data: { role } });
        }
      },
    };
  },
};
