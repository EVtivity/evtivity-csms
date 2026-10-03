// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import DOMPurify from 'dompurify';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { toUiLanguage } from '@evtivity/lib/languages';
import { api } from '@/lib/api';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { LoadingLogo } from '@/components/loading-logo';

export function TermsOfService(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = toUiLanguage(i18n.language);
  const { companyName, companyLogo } = useAuthBranding();
  const { data, isLoading } = useQuery({
    queryKey: ['content', 'terms-of-service', lang],
    queryFn: () => api.get<{ html: string }>(`/v1/portal/content/terms-of-service?lang=${lang}`),
  });
  const safeHtml = data != null ? DOMPurify.sanitize(data.html) : '';
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} linkTo="/login" />
        <Link
          to="/login"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-8"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('nav.back')}
        </Link>
        {isLoading ? (
          <LoadingLogo size="inline" />
        ) : (
          // Content is sanitized with DOMPurify before rendering
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        )}
      </div>
      <AuthFooter companyName={companyName} />
    </div>
  );
}
