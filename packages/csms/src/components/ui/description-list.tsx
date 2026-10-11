// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { cn } from '@/lib/utils';

/**
 * A compact label and value list: label above value on phones, label column
 * and value column from `sm`.
 */
export function DescriptionList({
  className,
  ...props
}: React.HTMLAttributes<HTMLDListElement>): React.JSX.Element {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-2',
        className,
      )}
      {...props}
    />
  );
}

export function DescriptionItem({
  label,
  children,
  valueTestId,
}: {
  label: string;
  children: React.ReactNode;
  valueTestId?: string;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mb-2 min-w-0 wrap-anywhere sm:mb-0" data-testid={valueTestId}>
        {children}
      </dd>
    </>
  );
}
