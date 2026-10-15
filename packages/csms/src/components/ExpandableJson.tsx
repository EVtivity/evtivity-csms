// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ai/CodeBlock';

/** One-line preview of a JSON value for a table cell. */
export function jsonPreview(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

/**
 * The toggle in a log table cell: a one-line, truncated preview of the JSON
 * with a chevron. It names its state in `aria-expanded` and points at the
 * detail panel with `aria-controls`. The row around it toggles on click too,
 * so the button stops its click from reaching the row.
 */
export function JsonPreviewToggle({
  value,
  expanded,
  onToggle,
  controlsId,
}: {
  value: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
}): React.JSX.Element {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <Button
      type="button"
      variant="ghost"
      size="row-sm"
      className="min-w-0 max-w-md font-mono"
      aria-expanded={expanded}
      aria-controls={controlsId}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{jsonPreview(value)}</span>
    </Button>
  );
}

/**
 * The expanded detail under a log row: the value as indented JSON in the
 * shared code block with its copy button. `w-0 min-w-full` keeps a long line
 * from widening the table: the block takes the cell's width and scrolls.
 */
export function JsonDetailBlock({
  id,
  value,
}: {
  id: string;
  value: Record<string, unknown>;
}): React.JSX.Element {
  return (
    <div id={id} className="w-0 min-w-full" data-testid="json-detail">
      <CodeBlock code={JSON.stringify(value, null, 2)} language="JSON" bounded />
    </div>
  );
}
