// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EyeOff, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SortableWidgetProps {
  id: string;
  name: string;
  editing: boolean;
  onHide: (id: string) => void;
  className?: string | undefined;
  children: React.ReactNode;
}

/**
 * One dashboard widget in a `SortableZone`. In edit mode it carries a drag
 * handle (the only place a pointer or touch drag starts, so phones still
 * scroll) and a hide button; outside it renders the widget alone. A widget
 * that renders nothing takes no grid cell (`empty:hidden`).
 */
export function SortableWidget(props: SortableWidgetProps): React.JSX.Element {
  if (!props.editing) {
    return (
      <div className={cn('min-w-0 empty:hidden', props.className)} data-widget={props.id}>
        {props.children}
      </div>
    );
  }
  return <EditableWidget {...props} />;
}

function EditableWidget({
  id,
  name,
  onHide,
  className,
  children,
}: SortableWidgetProps): React.JSX.Element {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-widget={id}
      className={cn(
        'relative min-w-0 rounded-lg outline-dashed outline-2 outline-offset-2 outline-border',
        isDragging && 'z-10 opacity-70',
        className,
      )}
    >
      <div className="absolute right-2 top-2 z-10 flex gap-1 rounded-md border border-border bg-background/95 p-0.5 shadow-xs">
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="cursor-grab touch-none"
          aria-label={t('dashboard.moveWidget', { name })}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('dashboard.hideWidget', { name })}
          onClick={() => {
            onHide(id);
          }}
        >
          <EyeOff className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}
