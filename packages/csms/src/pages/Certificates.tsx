// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useHasPermission } from '@/lib/auth';
import { CaCertificatesTab } from '@/components/certificates/CaCertificatesTab';
import { StationCertificatesTab } from '@/components/certificates/StationCertificatesTab';
import { CsrRequestsTab } from '@/components/certificates/CsrRequestsTab';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';

export function Certificates(): React.JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTab('ca');
  const canReadAudit = useHasPermission('audit:read');

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl md:text-3xl font-bold">{t('pnc.certificates')}</h1>
        <p className="text-sm text-muted-foreground">{t('pnc.certificatesSubtitle')}</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="ca">{t('pnc.caCertificates')}</TabsTrigger>
          <TabsTrigger value="station">{t('pnc.stationCertificates')}</TabsTrigger>
          <TabsTrigger value="csr">{t('pnc.csrRequests')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <CaCertificatesTab />
        <StationCertificatesTab />
        <CsrRequestsTab />
        <TabsContent value="history">
          <EntityHistoryTab entityType="certificate" entityId={null} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
