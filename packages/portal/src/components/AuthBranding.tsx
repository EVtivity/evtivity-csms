// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';

import { LanguageSelect } from '@/components/ui/language-select';
import { tryParseJson } from '@evtivity/lib/safe-json';
import { api } from '@/lib/api';
import { APP_VERSION } from '@/lib/version';

interface Branding {
  name?: string;
  logo?: string;
  themeColor?: string;
  contactEmail?: string;
  supportPhone?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  favicon?: string;
  metaDescription?: string;
  metaKeywords?: string;
  ogImage?: string;
}

function setMetaTag(attr: string, key: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (content === '') {
    el?.remove();
    return;
  }
  if (el == null) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (href === '') {
    link?.remove();
    return;
  }
  if (link == null) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

/** The last company name and logo this browser loaded, for screens shown while the API is down. */
const BRANDING_CACHE_KEY = 'portal_branding';

export interface CachedBranding {
  name: string | null;
  logo: string | null;
}

export function readCachedBranding(): CachedBranding | null {
  let text: string | null;
  try {
    text = localStorage.getItem(BRANDING_CACHE_KEY);
  } catch {
    // fail-open: storage is unavailable in private mode, so the default logo shows
    return null;
  }
  const parsed = tryParseJson(text ?? '') as Partial<CachedBranding> | undefined;
  if (parsed == null || typeof parsed !== 'object') return null;
  return {
    name: typeof parsed.name === 'string' ? parsed.name : null,
    logo: typeof parsed.logo === 'string' ? parsed.logo : null,
  };
}

function rememberBranding(value: CachedBranding): void {
  try {
    localStorage.setItem(BRANDING_CACHE_KEY, JSON.stringify(value));
  } catch (err: unknown) {
    console.warn('Keeping the company branding for offline screens failed', err);
  }
}

export function useAuthBranding(): {
  companyName: string | null;
  companyLogo: string | null;
  branding: Branding | undefined;
} {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Branding>('/v1/portal/branding'),
  });
  const liveName = branding?.name != null && branding.name !== '' ? branding.name : null;
  const liveLogo = branding?.logo != null && branding.logo !== '' ? branding.logo : null;
  // Until branding loads (or while the API is down), show the last one this browser saw.
  const cached = branding == null ? readCachedBranding() : null;
  const companyName = branding == null ? (cached?.name ?? null) : liveName;
  const companyLogo = branding == null ? (cached?.logo ?? null) : liveLogo;

  useEffect(() => {
    if (branding == null) return;
    rememberBranding({ name: liveName, logo: liveLogo });
  }, [branding, liveName, liveLogo]);

  useEffect(() => {
    const color =
      branding?.themeColor != null && branding.themeColor !== '' ? branding.themeColor : '#2563eb';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  }, [branding?.themeColor]);

  useEffect(() => {
    if (branding == null) return;
    const name = companyName ?? 'EVtivity';
    document.title = name;
    setFavicon(branding.favicon ?? '');
    setMetaTag('name', 'description', branding.metaDescription ?? '');
    setMetaTag('name', 'keywords', branding.metaKeywords ?? '');
    setMetaTag('property', 'og:title', name);
    setMetaTag('property', 'og:description', branding.metaDescription ?? '');
    setMetaTag('property', 'og:image', branding.ogImage ?? '');
  }, [branding, companyName]);

  return { companyName, companyLogo, branding };
}

export function AuthBranding({
  companyName,
  companyLogo,
  linkTo,
}: {
  companyName: string | null;
  companyLogo: string | null;
  linkTo?: string;
}): React.JSX.Element {
  const inner = (
    <div className="mb-4 flex flex-col items-center gap-2">
      <img
        src={companyLogo ?? '/evtivity-logo-animated.svg'}
        alt={companyName ?? 'EVtivity'}
        className="h-20 w-20 object-contain"
      />
      {companyName != null && (
        <div className="text-center">
          <h1 className="text-3xl font-bold">{companyName}</h1>
          <p className="text-[10px] text-muted-foreground">Powered by EVtivity Portal</p>
        </div>
      )}
    </div>
  );
  if (linkTo != null) {
    return (
      <Link to={linkTo} className="block transition-opacity hover:opacity-80">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function AuthFooter({
  companyName,
  branding,
  recaptchaEnabled,
}: {
  companyName: string | null;
  branding?: Branding | undefined;
  recaptchaEnabled?: boolean | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const name = companyName ?? 'EVtivity';

  const addressParts = [
    branding?.street,
    branding?.city,
    branding?.state,
    branding?.zip,
    branding?.country,
  ].filter((p) => p != null && p !== '');

  return (
    <footer className="mt-6 pb-8 text-center text-xs text-muted-foreground space-y-4">
      <div className="flex justify-center">
        <LanguageSelect className="w-auto" />
      </div>
      {addressParts.length > 0 && <p>{addressParts.join(', ')}</p>}
      {branding?.contactEmail != null && branding.contactEmail !== '' && (
        <p>{branding.contactEmail}</p>
      )}
      {branding?.supportPhone != null && branding.supportPhone !== '' && (
        <p>{branding.supportPhone}</p>
      )}
      <div className="space-y-1">
        <p>
          <Link to="/privacy-policy" className="hover:underline">
            {t('authFooter.privacyPolicy')}
          </Link>
          {' | '}
          <Link to="/terms-of-service" className="hover:underline">
            {t('authFooter.termsOfService')}
          </Link>
        </p>
        <p>{t('authFooter.allRightsReserved', { year: String(year), name })}</p>
        <p>v{APP_VERSION}</p>
        {recaptchaEnabled === true && (
          <p className="pt-1">
            {t('authFooter.recaptchaProtected')}{' '}
            <a
              href="https://policies.google.com/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {t('authFooter.recaptchaPrivacy')}
            </a>
            {' - '}
            <a
              href="https://policies.google.com/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {t('authFooter.recaptchaTerms')}
            </a>
          </p>
        )}
      </div>
    </footer>
  );
}
