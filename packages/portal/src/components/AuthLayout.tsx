// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Card } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { cn } from '@/lib/utils';

/**
 * The page around every standalone sign-in step (sign in, verification, MFA
 * setup, register, activate, reset and forgot password, the emailed verify
 * link): the company logo and name, one centered card and the footer. The page
 * puts its `CardHeader` (an `h2` title) and `CardContent` inside.
 */
export function AuthLayout({
  children,
  width = 'sm',
  recaptchaEnabled,
}: {
  children: React.ReactNode;
  /** `sm` for a form, `md` for the MFA setup with its QR code and recovery codes. */
  width?: 'sm' | 'md';
  recaptchaEnabled?: boolean | undefined;
}): React.JSX.Element {
  const { companyName, companyLogo, branding } = useAuthBranding();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className={cn('w-full', width === 'md' ? 'max-w-md' : 'max-w-sm')}>{children}</Card>
      <AuthFooter
        companyName={companyName}
        branding={branding}
        recaptchaEnabled={recaptchaEnabled}
      />
    </div>
  );
}
