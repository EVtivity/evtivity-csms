// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const DialogContext = React.createContext<{ onClose: () => void }>({ onClose: () => {} });

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

function Dialog({ open, onOpenChange, children }: DialogProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <DialogContext.Provider
      value={{
        onClose: () => {
          onOpenChange(false);
        },
      }}
    >
      <div className="fixed inset-0 z-50">
        <div
          className="fixed inset-0 bg-foreground/80"
          onClick={() => {
            onOpenChange(false);
          }}
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">{children}</div>
      </div>
    </DialogContext.Provider>
  );
}

function DialogContent({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const { onClose } = React.useContext(DialogContext);

  return (
    <div
      className={cn(
        'relative z-50 w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg grid gap-4',
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
      }}
      {...props}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </button>
      {children}
    </div>
  );
}

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)}
      {...props}
    />
  );
}

function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h2 className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
  );
}

function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter };
