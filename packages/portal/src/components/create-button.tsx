// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CreateButtonProps {
  label: string;
  onClick?: () => void;
  /** Defaults to button, so the button never submits a form it sits in. */
  type?: 'button' | 'submit';
  /**
   * `default` (the brand blue) for page, card and tab create actions and the
   * submits of create pages and dialogs; `outline` for a button that adds a
   * row or entry inside a form, so the form's submit stays the one blue action.
   */
  variant?: 'default' | 'outline';
  disabled?: boolean;
  size?: 'default' | 'sm';
  /** Tells why the button is disabled (a tooltip on hover). */
  title?: string | undefined;
  testId?: string;
  /** Spans the width of its container (portal forms and cards on phones). */
  fullWidth?: boolean;
}

/**
 * Every create or add action of the CSMS and the portal, with a Plus icon. The
 * CSMS and the portal copies of this file are identical. One blue action per
 * area: page and card create actions are blue (`default`), add-a-row controls
 * inside a form are `outline`. Green is for confirming, never for create or add.
 * `gap-2` spaces the icon in the portal, whose Button has no gap of its own.
 */
export function CreateButton({
  label,
  onClick,
  type = 'button',
  variant = 'default',
  disabled,
  size,
  title,
  testId,
  fullWidth = false,
}: CreateButtonProps): React.JSX.Element {
  return (
    <Button
      type={type}
      variant={variant}
      size={size}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={fullWidth ? 'w-full gap-2' : 'gap-2'}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}
