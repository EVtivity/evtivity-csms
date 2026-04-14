// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export function Pagination({
  page,
  totalPages,
  onPageChange,
}: PaginationProps): React.JSX.Element | null {
  const { t } = useTranslation();

  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-4">
      <Button
        variant="outline"
        size="sm"
        disabled={page === 1}
        onClick={() => {
          onPageChange(page - 1);
        }}
      >
        <ChevronLeft className="h-4 w-4" />
        {t('common.prev')}
      </Button>
      <span className="text-sm text-muted-foreground">
        {t('common.pageOf', { page, totalPages })}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page === totalPages}
        onClick={() => {
          onPageChange(page + 1);
        }}
      >
        {t('common.next')}
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
