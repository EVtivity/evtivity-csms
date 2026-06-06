// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEntityNeighbors } from '@/hooks/use-entity-neighbors';

interface EntityNavButtonsProps {
  /** API resource segment for the neighbors endpoint, e.g. 'sites' or 'ocpi/partners'. */
  resource: string;
  /** Frontend detail route prefix, e.g. '/sites' or '/roaming/partners'. */
  basePath: string;
  currentId: string | undefined;
}

interface NavButtonProps {
  to: string | null;
  label: string;
  icon: React.JSX.Element;
}

function NavButton({ to, label, icon }: NavButtonProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1">
      {to != null ? (
        <Link to={to}>
          <Button variant="outline" size="icon" aria-label={label}>
            {icon}
          </Button>
        </Link>
      ) : (
        <Button variant="outline" size="icon" aria-label={label} disabled>
          {icon}
        </Button>
      )}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function EntityNavButtons({
  resource,
  basePath,
  currentId,
}: EntityNavButtonsProps): React.JSX.Element {
  const { t } = useTranslation();
  const { prevId, nextId } = useEntityNeighbors(resource, currentId);

  return (
    <div className="ml-auto flex items-start gap-2">
      <NavButton
        to={prevId != null ? `${basePath}/${prevId}` : null}
        label={t('common.prev')}
        icon={<ChevronLeft className="h-4 w-4" />}
      />
      <NavButton
        to={nextId != null ? `${basePath}/${nextId}` : null}
        label={t('common.next')}
        icon={<ChevronRight className="h-4 w-4" />}
      />
    </div>
  );
}
