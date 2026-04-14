// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CaCertificatesTab } from '@/components/certificates/CaCertificatesTab';
import { StationCertificatesTab } from '@/components/certificates/StationCertificatesTab';
import { CsrRequestsTab } from '@/components/certificates/CsrRequestsTab';

export function Certificates(): React.JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTab('ca');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl md:text-3xl font-bold">{t('pnc.certificates')}</h1>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="ca">{t('pnc.caCertificates')}</TabsTrigger>
          <TabsTrigger value="station">{t('pnc.stationCertificates')}</TabsTrigger>
          <TabsTrigger value="csr">{t('pnc.csrRequests')}</TabsTrigger>
        </TabsList>

        <CaCertificatesTab />
        <StationCertificatesTab />
        <CsrRequestsTab />
      </Tabs>
    </div>
  );
}
