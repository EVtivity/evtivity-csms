// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const toastVariants = cva(
  'rounded-lg border border-l-4 bg-background p-4 shadow-lg flex items-start gap-3 animate-slide-in-from-bottom',
  {
    variants: {
      variant: {
        default: 'border-l-border',
        success: 'border-l-success',
        warning: 'border-l-warning',
        destructive: 'border-l-destructive',
        info: 'border-l-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

type ToastVariant = NonNullable<VariantProps<typeof toastVariants>['variant']>;

const VARIANT_ICONS: Record<string, React.ReactNode> = {
  success: <Check className="h-5 w-5 text-success shrink-0 mt-0.5" />,
  warning: <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />,
  destructive: <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />,
  info: <Info className="h-5 w-5 text-info shrink-0 mt-0.5" />,
};

interface ToastData {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

interface ToastContextValue {
  toast: (opts: Omit<ToastData, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue>({
  toast: () => {},
  dismiss: () => {},
});

let toastCounter = 0;

const MAX_VISIBLE = 3;
const AUTO_DISMISS_MS = 5000;

function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);
  const timersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const hoveredRef = React.useRef<Set<string>>(new Set());

  const dismiss = React.useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer != null) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    hoveredRef.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const startTimer = React.useCallback(
    (id: string, variant?: ToastVariant) => {
      if (variant === 'destructive') return;
      const timer = setTimeout(() => {
        dismiss(id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  const toast = React.useCallback(
    (opts: Omit<ToastData, 'id'>) => {
      toastCounter += 1;
      const id = `toast-${String(toastCounter)}`;
      const newToast: ToastData = { ...opts, id };
      setToasts((prev) => {
        const next = [newToast, ...prev];
        if (next.length > MAX_VISIBLE) {
          const removed = next.slice(MAX_VISIBLE);
          for (const r of removed) {
            const t = timersRef.current.get(r.id);
            if (t != null) {
              clearTimeout(t);
              timersRef.current.delete(r.id);
            }
          }
          return next.slice(0, MAX_VISIBLE);
        }
        return next;
      });
      startTimer(id, opts.variant);
    },
    [startTimer],
  );

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer
        toasts={toasts}
        onDismiss={dismiss}
        onMouseEnter={(id) => {
          hoveredRef.current.add(id);
          const timer = timersRef.current.get(id);
          if (timer != null) {
            clearTimeout(timer);
            timersRef.current.delete(id);
          }
        }}
        onMouseLeave={(id) => {
          hoveredRef.current.delete(id);
          const t = toasts.find((toast) => toast.id === id);
          if (t != null) {
            startTimer(id, t.variant);
          }
        }}
      />
    </ToastContext.Provider>
  );
}

function useToast(): ToastContextValue {
  return React.useContext(ToastContext);
}

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
  onMouseEnter: (id: string) => void;
  onMouseLeave: (id: string) => void;
}

function ToastContainer({
  toasts,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: ToastContainerProps): React.JSX.Element {
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <Toast
          key={t.id}
          {...t}
          onDismiss={() => {
            onDismiss(t.id);
          }}
          onMouseEnter={() => {
            onMouseEnter(t.id);
          }}
          onMouseLeave={() => {
            onMouseLeave(t.id);
          }}
        />
      ))}
    </div>
  );
}

interface ToastProps extends ToastData {
  onDismiss: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function Toast({
  title,
  description,
  variant = 'default',
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: ToastProps): React.JSX.Element {
  const icon = VARIANT_ICONS[variant];

  return (
    <div
      className={cn(toastVariants({ variant }))}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {icon}
      <div className="flex-1 grid gap-1">
        {title != null && <p className="text-sm font-semibold">{title}</p>}
        {description != null && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export { ToastProvider, useToast, Toast, toastVariants };
