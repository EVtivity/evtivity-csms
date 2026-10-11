// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { api } from '@/lib/api';

interface Site {
  id: string;
  freeVendEnabled: boolean;
  freeVendTemplateId21: string | null;
  freeVendTemplateId16: string | null;
}

export interface SiteFreeVendTabProps {
  site: Site;
  siteId: string;
}

export function SiteFreeVendTab({ site, siteId }: SiteFreeVendTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const freeVendMutation = useMutation({
    mutationFn: (enabled: boolean) => api.post(`/v1/sites/${siteId}/free-vend`, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  return (
    <TabsContent value="free-vend" className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="grid gap-1">
              <Label>{t('sites.freeVend')}</Label>
              <p className="text-xs text-muted-foreground">{t('sites.freeVendDescription')}</p>
            </div>
            <Toggle
              aria-label={t('sites.freeVend')}
              size="lg"
              checked={site.freeVendEnabled}
              onCheckedChange={() => {
                freeVendMutation.mutate(!site.freeVendEnabled);
              }}
              disabled={freeVendMutation.isPending}
            />
          </div>
        </CardContent>
      </Card>

      {!site.freeVendEnabled && site.freeVendTemplateId21 != null && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">{t('sites.freeVendDisabledNote')}</p>
          </CardContent>
        </Card>
      )}

      {site.freeVendTemplateId21 != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.freeVendOcpp21Template')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={`/station-configurations/${site.freeVendTemplateId21}`}
              className="text-link hover:underline text-sm"
            >
              {t('sites.freeVendViewTemplate')}
            </Link>
          </CardContent>
        </Card>
      )}

      {site.freeVendTemplateId16 != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.freeVendOcpp16Template')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link
              to={`/station-configurations/${site.freeVendTemplateId16}`}
              className="text-link hover:underline text-sm"
            >
              {t('sites.freeVendViewTemplate')}
            </Link>
            <p className="text-xs text-muted-foreground mt-2">{t('sites.freeVendOcpp16Note')}</p>
          </CardContent>
        </Card>
      )}
    </TabsContent>
  );
}
