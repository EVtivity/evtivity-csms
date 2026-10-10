// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';
import { Check, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { toastDurationMs } from '@evtivity/lib/toast-durations';
import { cn } from '@/lib/utils';

const toastVariants = cva(
  'rounded-lg border border-l-4 bg-background p-4 shadow-lg flex items-start gap-3 animate-slide-in-from-bottom motion-reduce:animate-none',
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

// Hover and keyboard focus each pause the timer; it runs again when both end.
type PauseReason = 'hover' | 'focus';

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  remainingMs: number;
  paused: Set<PauseReason>;
}

function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);
  const timersRef = React.useRef<Map<string, ToastTimer>>(new Map());

  const clearTimer = React.useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer?.handle != null) clearTimeout(timer.handle);
    timersRef.current.delete(id);
  }, []);

  const remove = React.useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const run = React.useCallback(
    (id: string, timer: ToastTimer) => {
      timer.startedAt = Date.now();
      timer.handle = setTimeout(() => {
        remove(id);
      }, timer.remainingMs);
    },
    [remove],
  );

  const pause = React.useCallback((id: string, reason: PauseReason) => {
    const timer = timersRef.current.get(id);
    if (timer == null) return;
    timer.paused.add(reason);
    if (timer.handle == null) return;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
  }, []);

  const resume = React.useCallback(
    (id: string, reason: PauseReason) => {
      const timer = timersRef.current.get(id);
      if (timer == null) return;
      timer.paused.delete(reason);
      if (timer.paused.size > 0 || timer.handle != null) return;
      run(id, timer);
    },
    [run],
  );

  const toast = React.useCallback(
    (opts: Omit<ToastData, 'id'>) => {
      toastCounter += 1;
      const id = `toast-${String(toastCounter)}`;
      const newToast: ToastData = { ...opts, id };
      setToasts((prev) => {
        const next = [newToast, ...prev];
        if (next.length > MAX_VISIBLE) {
          for (const r of next.slice(MAX_VISIBLE)) clearTimer(r.id);
          return next.slice(0, MAX_VISIBLE);
        }
        return next;
      });
      const timer: ToastTimer = {
        handle: null,
        startedAt: Date.now(),
        remainingMs: toastDurationMs(opts.variant ?? 'default', false),
        paused: new Set(),
      };
      timersRef.current.set(id, timer);
      run(id, timer);
    },
    [clearTimer, run],
  );

  const dismiss = remove;

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        if (timer.handle != null) clearTimeout(timer.handle);
      }
      timers.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} onPause={pause} onResume={resume} />
    </ToastContext.Provider>
  );
}

function useToast(): ToastContextValue {
  return React.useContext(ToastContext);
}

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
  onPause: (id: string, reason: PauseReason) => void;
  onResume: (id: string, reason: PauseReason) => void;
}

function ToastContainer({
  toasts,
  onDismiss,
  onPause,
  onResume,
}: ToastContainerProps): React.JSX.Element {
  // The live region stays mounted so screen readers announce each new toast.
  return (
    <div
      aria-live="polite"
      aria-relevant="additions"
      className="fixed top-4 right-4 z-100 flex flex-col gap-2 max-w-sm"
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          {...t}
          onDismiss={() => {
            onDismiss(t.id);
          }}
          onPause={(reason) => {
            onPause(t.id, reason);
          }}
          onResume={(reason) => {
            onResume(t.id, reason);
          }}
        />
      ))}
    </div>
  );
}

interface ToastProps extends ToastData {
  onDismiss: () => void;
  onPause: (reason: PauseReason) => void;
  onResume: (reason: PauseReason) => void;
}

function Toast({
  title,
  description,
  variant = 'default',
  onDismiss,
  onPause,
  onResume,
}: ToastProps): React.JSX.Element {
  const { t } = useTranslation();
  const icon = VARIANT_ICONS[variant];

  return (
    <div
      role={variant === 'destructive' ? 'alert' : 'status'}
      className={cn(toastVariants({ variant }))}
      onMouseEnter={() => {
        onPause('hover');
      }}
      onMouseLeave={() => {
        onResume('hover');
      }}
      onFocus={() => {
        onPause('focus');
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onResume('focus');
      }}
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
        aria-label={t('common.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export { ToastProvider, useToast, Toast, toastVariants };
