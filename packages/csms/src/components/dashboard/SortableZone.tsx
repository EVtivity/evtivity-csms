// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';

/**
 * A zone of dashboard widgets the user reorders by drag and drop: with a
 * pointer by the drag handle, or with the keyboard (Space picks up, the arrow
 * keys move, Space drops, Escape cancels), announced in the UI language.
 * Outside edit mode it renders its children only.
 */
export function SortableZone({
  ids,
  names,
  editing,
  onMove,
  children,
}: {
  /** The ids of the widgets shown, in display order. */
  ids: string[];
  /** The display name of each widget, for the screen reader announcements. */
  names: Record<string, string>;
  editing: boolean;
  /** The widget `activeId` was dropped onto the place of `overId`. */
  onMove: (activeId: string, overId: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const sensors = useSensors(
    // A short move starts a drag, so a click on the handle is not one.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (!editing) return <>{children}</>;

  const name = (id: UniqueIdentifier): string => names[String(id)] ?? String(id);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dashboard.dnd.pickedUp', { name: name(active.id) }),
    onDragOver: ({ active, over }) =>
      over != null
        ? t('dashboard.dnd.movedOver', { name: name(active.id), over: name(over.id) })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over != null
        ? t('dashboard.dnd.dropped', { name: name(active.id), over: name(over.id) })
        : t('dashboard.dnd.cancelled', { name: name(active.id) }),
    onDragCancel: ({ active }) => t('dashboard.dnd.cancelled', { name: name(active.id) }),
  };

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (over != null && active.id !== over.id) onMove(String(active.id), String(over.id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('dashboard.dnd.instructions') },
      }}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}
