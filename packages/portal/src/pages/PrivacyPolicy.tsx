// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import DOMPurify from 'dompurify';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';

function detectLang(): 'en' | 'es' | 'zh' {
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith('es')) return 'es';
  if (lang.startsWith('zh')) return 'zh';
  return 'en';
}

export function PrivacyPolicy(): React.JSX.Element {
  const { t } = useTranslation();
  const lang = detectLang();
  const { companyName, companyLogo, branding } = useAuthBranding();
  const { data, isLoading } = useQuery({
    queryKey: ['content', 'privacy-policy', lang],
    queryFn: () => api.get<{ html: string }>(`/v1/portal/content/privacy-policy?lang=${lang}`),
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
          {t('common.back')}
        </Link>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          // Content is sanitized with DOMPurify before rendering
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
        )}
      </div>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
