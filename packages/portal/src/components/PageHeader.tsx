// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { isVisitStart } from '@/hooks/use-back-to-parent';

interface PageHeaderProps {
  title: string;
  backTo?: string | number;
  // Where a history back goes when the page is the first one of the visit
  // (opened from a link or a page load), which has nothing to go back to.
  fallbackTo?: string;
  // Replaces backTo for pages whose back depends on how they were opened.
  onBack?: () => void;
  children?: React.ReactNode;
}

export function PageHeader({
  title,
  backTo = -1,
  fallbackTo,
  onBack,
  children,
}: PageHeaderProps): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            if (onBack != null) {
              onBack();
            } else if (typeof backTo === 'string') {
              void navigate(backTo);
            } else if (fallbackTo != null && isVisitStart(location)) {
              void navigate(fallbackTo, { replace: true });
            } else {
              void navigate(backTo);
            }
          }}
          aria-label={t('common.back')}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-xl font-bold">{title}</h1>
      </div>
      {children != null && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}
