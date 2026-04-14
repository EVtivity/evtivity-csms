// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function NotFound(): React.JSX.Element {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <FileQuestion className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-2xl font-bold">{t('common.pageNotFound')}</h1>
      <p className="text-sm text-muted-foreground">{t('common.pageNotFoundDescription')}</p>
      <Button
        size="lg"
        onClick={() => {
          void navigate('/');
        }}
      >
        {t('common.backToHome')}
      </Button>
    </div>
  );
}
