// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// A catch clause decides what a failure means: rethrow it, or log it and
// continue. A catch that drops the error (no binding, a binding it never reads,
// or `void err`) hides failures. The rare catch where the failure is expected
// and carries no information states why with a `// fail-open: <reason>` comment
// inside the catch block.

const MARKER = /^\s*fail-open:(.*)$/;
const MIN_REASON_WORDS = 2;

function markerReason(comments) {
  for (const comment of comments) {
    const match = MARKER.exec(comment.value);
    if (match != null) return match[1].trim();
  }
  return null;
}

function isVoided(reference) {
  const parent = reference.identifier.parent;
  return parent?.type === 'UnaryExpression' && parent.operator === 'void';
}

export const handleCaughtError = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every catch clause to use the error it catches (rethrow, narrow, log or show it) or to state why the failure is expected with a fail-open comment.',
    },
    schema: [],
    messages: {
      noBinding:
        'Catch clause drops the error. Bind it and rethrow, log it with context, or show it to the user. If the failure is expected and carries no information, use a helper that returns a fallback (tryParseJson, URL.parse) or add a "// fail-open: <reason>" comment inside the catch block.',
      unusedBinding:
        'Caught error "{{name}}" is never used. Rethrow it, log it with context, or show it to the user. If the failure is expected and carries no information, drop the binding and add a "// fail-open: <reason>" comment inside the catch block.',
      markerWithoutReason:
        'A "// fail-open:" comment needs a reason of at least two words that says why this failure is expected and safe to ignore.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CatchClause(node) {
        const reason = markerReason(sourceCode.getCommentsInside(node.body));
        if (reason != null) {
          if (reason.split(/\s+/).filter(Boolean).length < MIN_REASON_WORDS) {
            context.report({ node, messageId: 'markerWithoutReason' });
          }
          return;
        }
        if (node.param == null) {
          context.report({ node, messageId: 'noBinding' });
          return;
        }
        const variables = sourceCode.getDeclaredVariables(node);
        const used = variables.some((variable) =>
          variable.references.some((reference) => !isVoided(reference)),
        );
        if (!used) {
          const name = node.param.type === 'Identifier' ? node.param.name : 'error';
          context.report({ node: node.param, messageId: 'unusedBinding', data: { name } });
        }
      },
    };
  },
};

export const evtivityPlugin = {
  meta: { name: 'evtivity' },
  rules: {
    'handle-caught-error': handleCaughtError,
  },
};
