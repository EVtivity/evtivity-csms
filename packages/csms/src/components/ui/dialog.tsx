// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

interface DialogContextValue {
  onClose: () => void;
  /** Id of the DialogTitle, which names the dialog (aria-labelledby). */
  titleId?: string;
  /** Id of the DialogDescription, set while one is rendered (aria-describedby). */
  descriptionId?: string;
  registerDescription?: () => () => void;
}

const DialogContext = React.createContext<DialogContextValue>({ onClose: () => {} });

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /**
   * False while the dialog must not be dismissed (an action is running): Escape
   * and a click on the backdrop then leave it open. Default true.
   */
  dismissible?: boolean;
}

// Open dialogs in the order they opened. Escape closes only the topmost one.
const openDialogs: symbol[] = [];

// Escape dismisses the topmost dialog, and focus returns to the element that
// had it when the dialog opened. Mounted only while the dialog is open.
function useDialogDismiss(onDismiss: () => void, dismissible: boolean): void {
  // Read during the first render, before an autoFocus child takes focus.
  const [returnFocusTo] = React.useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );
  const latest = React.useRef({ onDismiss, dismissible });
  React.useEffect(() => {
    latest.current = { onDismiss, dismissible };
  });

  React.useEffect(() => {
    const token = Symbol('dialog');
    openDialogs.push(token);
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (openDialogs[openDialogs.length - 1] !== token) return;
      // The topmost dialog consumes Escape even while busy, so the dialog
      // below it does not close instead.
      e.preventDefault();
      if (latest.current.dismissible) latest.current.onDismiss();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = openDialogs.indexOf(token);
      if (index !== -1) openDialogs.splice(index, 1);
      if (returnFocusTo instanceof HTMLElement && returnFocusTo.isConnected) {
        returnFocusTo.focus();
      }
    };
  }, [returnFocusTo]);
}

function Dialog({
  open,
  onOpenChange,
  children,
  dismissible = true,
}: DialogProps): React.JSX.Element | null {
  if (!open) return null;
  return (
    <OpenDialog onOpenChange={onOpenChange} dismissible={dismissible}>
      {children}
    </OpenDialog>
  );
}

function OpenDialog({
  onOpenChange,
  children,
  dismissible,
}: Omit<DialogProps, 'open'> & { dismissible: boolean }): React.JSX.Element {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [descriptionCount, setDescriptionCount] = React.useState(0);
  const registerDescription = React.useCallback(() => {
    setDescriptionCount((n) => n + 1);
    return () => {
      setDescriptionCount((n) => n - 1);
    };
  }, []);
  useDialogDismiss(() => {
    onOpenChange(false);
  }, dismissible);

  return (
    <DialogContext.Provider
      value={{
        onClose: () => {
          onOpenChange(false);
        },
        titleId,
        ...(descriptionCount > 0 ? { descriptionId } : {}),
        registerDescription,
      }}
    >
      <div className="fixed inset-0 z-50">
        <div
          className="fixed inset-0 bg-foreground/80"
          onClick={() => {
            if (dismissible) onOpenChange(false);
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
  const { t } = useTranslation();
  const { onClose, titleId, descriptionId } = React.useContext(DialogContext);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
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
        className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        <X className="h-4 w-4" />
        <span className="sr-only">{t('common.close')}</span>
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
  const { titleId } = React.useContext(DialogContext);
  return (
    <h2
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
      id={titleId}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  const { descriptionId, registerDescription } = React.useContext(DialogContext);
  React.useEffect(() => registerDescription?.(), [registerDescription]);
  return (
    <p className={cn('text-sm text-muted-foreground', className)} {...props} id={descriptionId} />
  );
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 [&>button]:w-full sm:[&>button]:w-auto',
        className,
      )}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter };
