// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Minus, Plus, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useHomeCards } from '@/lib/home-cards-store';
import {
  HOME_CARDS,
  ALL_HOME_CARD_IDS,
  MIN_HOME_CARDS,
  MAX_HOME_CARDS,
  type HomeCardId,
} from '@/lib/home-cards';

function SortableCardRow({
  id,
  label,
  icon: Icon,
  canRemove,
  onRemove,
}: {
  id: HomeCardId;
  label: string;
  icon: LucideIcon;
  canRemove: boolean;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`home-card-row-${id}`}
      className="flex items-center gap-3 rounded-lg border bg-card p-3"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('homeCards.reorder', { card: label })}
        className="cursor-grab touch-none text-muted-foreground"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <Icon className="h-5 w-5 text-primary" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('homeCards.remove', { card: label })}
        disabled={!canRemove}
        data-testid={`home-card-remove-${id}`}
        onClick={onRemove}
      >
        <Minus className="h-4 w-4 text-destructive" />
      </Button>
    </div>
  );
}

export function AccountHomeCards(): React.JSX.Element {
  const { t } = useTranslation();
  const cards = useHomeCards((s) => s.cards);
  const setCards = useHomeCards((s) => s.setCards);

  const { data: features } = useQuery({
    queryKey: ['portal-features'],
    queryFn: () =>
      api.get<{ reservationEnabled: boolean; supportEnabled: boolean }>('/v1/portal/features'),
    staleTime: 5 * 60_000,
  });
  const supportEnabled = features?.supportEnabled ?? true;

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const pool = ALL_HOME_CARD_IDS.filter((id) => id !== 'support' || supportEnabled);
  const available = pool.filter((id) => !cards.includes(id));
  const canRemove = cards.length > MIN_HOME_CARDS;
  const canAdd = cards.length < MAX_HOME_CARDS;

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (over != null && active.id !== over.id) {
      const oldIndex = cards.indexOf(active.id as HomeCardId);
      const newIndex = cards.indexOf(over.id as HomeCardId);
      if (oldIndex !== -1 && newIndex !== -1) setCards(arrayMove(cards, oldIndex, newIndex));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('homeCards.hint')}</p>

      <div>
        <p className="mb-2 text-sm font-medium">{t('homeCards.onHome')}</p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={cards} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {cards.map((id) => (
                <SortableCardRow
                  key={id}
                  id={id}
                  label={t(HOME_CARDS[id].labelKey)}
                  icon={HOME_CARDS[id].icon}
                  canRemove={canRemove}
                  onRemove={() => {
                    setCards(cards.filter((c) => c !== id));
                  }}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {available.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">{t('homeCards.available')}</p>
          <div className="space-y-2">
            {available.map((id) => {
              const Icon = HOME_CARDS[id].icon;
              const label = t(HOME_CARDS[id].labelKey);
              return (
                <div
                  key={id}
                  className="flex items-center gap-3 rounded-lg border bg-card p-3"
                  data-testid={`home-card-available-${id}`}
                >
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <span className="flex-1 text-sm font-medium">{label}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('homeCards.add', { card: label })}
                    disabled={!canAdd}
                    data-testid={`home-card-add-${id}`}
                    onClick={() => {
                      setCards([...cards, id]);
                    }}
                  >
                    <Plus className="h-4 w-4 text-primary" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
