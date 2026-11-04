// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * A button label with a spinner over it while `pending`. The text stays in place, invisible, so
 * the button keeps its size. The button needs `relative`.
 */
export function ButtonPendingLabel({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      {pending && (
        <span
          className="absolute inset-0 flex items-center justify-center"
          data-testid="button-pending-spinner"
          aria-hidden="true"
        >
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
      )}
      <span className={pending ? 'invisible' : ''}>{children}</span>
    </>
  );
}
