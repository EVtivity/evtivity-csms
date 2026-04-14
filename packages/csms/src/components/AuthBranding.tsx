// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '@/lib/api';
import { APP_VERSION } from '@/lib/version';

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

export function useAuthBranding(): {
  companyName: string | null;
  companyLogo: string | null;
  portalUrl: string | null;
  themeColor: string;
} {
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<Record<string, string>>('/v1/portal/branding'),
  });
  const companyName = branding?.name != null && branding.name !== '' ? branding.name : null;
  const companyLogo = branding?.logo != null && branding.logo !== '' ? branding.logo : null;
  const portalUrl =
    branding?.portalUrl != null && branding.portalUrl !== '' ? branding.portalUrl : null;
  const themeColor =
    branding?.themeColor != null && branding.themeColor !== '' ? branding.themeColor : '#2563eb';

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  }, [themeColor]);

  useEffect(() => {
    if (branding == null) return;
    const name = companyName ?? 'EVtivity';
    document.title = `${name} CSMS`;
    setFavicon(branding.favicon ?? '');
    setMetaTag('name', 'description', branding.metaDescription ?? '');
    setMetaTag('name', 'keywords', branding.metaKeywords ?? '');
    setMetaTag('property', 'og:title', `${name} CSMS`);
    setMetaTag('property', 'og:description', branding.metaDescription ?? '');
    setMetaTag('property', 'og:image', branding.ogImage ?? '');
  }, [branding, companyName]);

  return { companyName, companyLogo, portalUrl, themeColor };
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
        src={companyLogo ?? '/evtivity-logo.svg'}
        alt={companyName ?? 'EVtivity'}
        className="h-20 w-20 object-contain"
      />
      {companyName != null && (
        <div className="text-center">
          <h1 className="text-3xl font-bold">{companyName}</h1>
          <p className="text-[10px] text-muted-foreground">Powered by EVtivity CSMS</p>
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
  recaptchaEnabled,
}: {
  companyName: string | null;
  recaptchaEnabled?: boolean | undefined;
}): React.JSX.Element {
  const year = new Date().getFullYear();
  const name = companyName ?? 'EVtivity';
  return (
    <footer className="mt-6 text-center text-xs text-muted-foreground space-y-1">
      <p>
        <Link to="/privacy-policy" className="hover:underline">
          Privacy Policy
        </Link>
        {' | '}
        <Link to="/terms-of-service" className="hover:underline">
          Terms of Service
        </Link>
      </p>
      <p>
        All rights reserved, {String(year)} {name}
      </p>
      <p>v{APP_VERSION}</p>
      {recaptchaEnabled === true && (
        <p className="pt-1">
          Protected by reCAPTCHA.{' '}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            Privacy
          </a>
          {' - '}
          <a
            href="https://policies.google.com/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            Terms
          </a>
        </p>
      )}
    </footer>
  );
}
