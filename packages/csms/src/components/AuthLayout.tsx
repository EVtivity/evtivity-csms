// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Card } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { cn } from '@/lib/utils';

/**
 * The page around every sign-in step (sign in, verification, MFA setup, set and
 * reset password, forgot password): the company logo and name, one centered
 * card and the footer. The page puts its `CardHeader` (an `h2` title) and
 * `CardContent` inside.
 */
export function AuthLayout({
  children,
  width = 'sm',
  recaptchaEnabled,
  aside,
}: {
  children: React.ReactNode;
  /** `sm` for a form, `md` for the MFA setup with its QR code and recovery codes. */
  width?: 'sm' | 'md';
  recaptchaEnabled?: boolean | undefined;
  /** Rendered before the branding, for a fixed element such as the portal link. */
  aside?: React.ReactNode;
}): React.JSX.Element {
  const { companyName, companyLogo } = useAuthBranding();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      {aside}
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className={cn('w-full', width === 'md' ? 'max-w-md' : 'max-w-sm')}>{children}</Card>
      <AuthFooter companyName={companyName} recaptchaEnabled={recaptchaEnabled} />
    </div>
  );
}
