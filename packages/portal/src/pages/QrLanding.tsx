// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { api } from '@/lib/api';

interface QrValidation {
  valid: boolean;
  stationId?: string;
  evseId?: number;
}

/**
 * Landing page of a dynamic QR code (OCPP 2.1 C25). The CSMS decodes the URL
 * and checks its one-time password; only a valid code continues to the charger
 * page and payment, keeping the QR code limit parameters (maxenergy, maxtime,
 * maxcost). An invalid code shows an error and stops there (C25.FR.08).
 */
export function QrLanding(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { companyName, companyLogo, branding } = useAuthBranding();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await api.post<QrValidation>('/v1/portal/guest/qr/validate', {
          url: window.location.href,
        });
        if (controller.signal.aborted) return;
        if (result.valid && result.stationId != null && result.evseId != null) {
          const query = window.location.search;
          void navigate(
            `/charge/${encodeURIComponent(result.stationId)}/${String(result.evseId)}${query}`,
            { replace: true },
          );
        } else {
          setInvalid(true);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn('Resolve the QR code station failed', err);
        setInvalid(true);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <h2 className="text-2xl font-semibold">
            {invalid ? t('qr.invalidTitle') : t('qr.checking')}
          </h2>
        </CardHeader>
        {invalid && (
          <CardContent>
            <p className="text-center text-sm text-muted-foreground">{t('qr.invalidMessage')}</p>
          </CardContent>
        )}
      </Card>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
