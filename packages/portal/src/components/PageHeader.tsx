// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PageHeaderProps {
  title: string;
  backTo?: string | number;
  children?: React.ReactNode;
}

export function PageHeader({ title, backTo = -1, children }: PageHeaderProps): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            if (typeof backTo === 'string') {
              void navigate(backTo);
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
