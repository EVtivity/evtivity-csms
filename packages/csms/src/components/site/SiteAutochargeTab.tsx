// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TabPanel } from '@/components/ui/tab-panel';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { useSavedToast } from '@/components/saved-message';

interface Site {
  id: string;
  autochargeEnabled?: boolean | null;
}

export interface SiteAutochargeTabProps {
  site: Site;
  siteId: string;
}

/** Site detail > Autocharge: the site's override of the company Autocharge setting. */
export function SiteAutochargeTab({ site, siteId }: SiteAutochargeTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const savedToast = useSavedToast();
  // Read-only without sites:write, which the API requires for the change.
  const canWrite = useHasPermission('sites:write');

  const autochargeMutation = useMutation({
    mutationFn: (value: boolean | null) =>
      api.patch(`/v1/sites/${siteId}`, { autochargeEnabled: value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      savedToast();
    },
  });

  return (
    <TabsContent value="autocharge">
      <TabPanel
        title={t('sites.autocharge')}
        description={t('sites.autochargeDescription')}
        bodyClassName="space-y-2"
      >
        <Select
          aria-label={t('sites.autocharge')}
          value={site.autochargeEnabled == null ? '' : site.autochargeEnabled ? 'on' : 'off'}
          onChange={(e) => {
            const val = e.target.value;
            autochargeMutation.mutate(val === '' ? null : val === 'on');
          }}
          disabled={!canWrite || autochargeMutation.isPending}
          className="max-w-sm"
        >
          <option value="">{t('sites.autochargeDefault')}</option>
          <option value="on">{t('vehicles.autochargeOn')}</option>
          <option value="off">{t('vehicles.autochargeOff')}</option>
        </Select>
        {autochargeMutation.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(autochargeMutation.error, t)}</p>
        )}
      </TabPanel>
    </TabsContent>
  );
}
