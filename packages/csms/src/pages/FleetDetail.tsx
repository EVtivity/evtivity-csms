// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { FleetDetailsTab } from '@/components/fleet/FleetDetailsTab';
import { FleetSessionsTab } from '@/components/fleet/FleetSessionsTab';
import { FleetStationsTab } from '@/components/fleet/FleetStationsTab';
import { FleetVehiclesTab } from '@/components/fleet/FleetVehiclesTab';
import { FleetDriversTab } from '@/components/fleet/FleetDriversTab';
import { FleetPricingTab } from '@/components/fleet/FleetPricingTab';
import { FleetReservationsTab } from '@/components/fleet/FleetReservationsTab';
import { FleetBillingTab } from '@/components/fleet/FleetBillingTab';
import { FleetBillingProfileCard } from '@/components/fleet/FleetBillingProfileCard';
import type { FleetBillingProfile } from '@/components/fleet/FleetBillingProfileCard';
import { FleetCreditLimitCard } from '@/components/fleet/FleetCreditLimitCard';
import { FleetInvoicesCard } from '@/components/fleet/FleetInvoicesCard';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission } from '@/lib/auth';
import { LoadingLogo } from '@/components/loading-logo';

interface Fleet extends Partial<FleetBillingProfile> {
  id: string;
  name: string;
  description: string | null;
  accountBillingEnabled?: boolean;
  hasPricingGroup?: boolean;
  createdAt: string;
  updatedAt: string;
}

export function FleetDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const canReadAudit = useHasPermission('audit:read');
  // Fleet billing and invoices are company-wide: the API answers 404 to a site-restricted user.
  const hasAllSiteAccess = useHasAllSiteAccess();
  const [activeTab, setActiveTab] = useTab('details');

  const { data: fleet, isLoading } = useQuery({
    queryKey: ['fleets', id],
    queryFn: () => api.get<Fleet>(`/v1/fleets/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (fleet == null) {
    return <p className="text-destructive">{t('fleets.fleetNotFound')}</p>;
  }

  const fleetId = id ?? '';
  // A site-restricted user changes the members only of a fleet with no
  // pricing group and no account billing (the API answers 404 otherwise).
  const canManageMembers =
    hasAllSiteAccess || (fleet.accountBillingEnabled !== true && fleet.hasPricingGroup !== true);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/fleets" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{fleet.name}</h1>
          <CopyableId id={fleet.id} />
        </div>
        <EntityNavButtons resource="fleets" basePath="/fleets" currentId={id} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          <TabsTrigger value="stations">{t('fleets.stations')}</TabsTrigger>
          <TabsTrigger value="vehicles">{t('fleets.vehicles')}</TabsTrigger>
          <TabsTrigger value="drivers">{t('fleets.drivers')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('fleets.pricing')}</TabsTrigger>
          {hasAllSiteAccess && <TabsTrigger value="billing">{t('fleets.billingTab')}</TabsTrigger>}
          <TabsTrigger value="reservations">{t('fleets.bulkReservations')}</TabsTrigger>
          {canReadAudit && <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>}
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <FleetDetailsTab fleetId={fleetId} fleet={fleet} />
        </TabsContent>

        <TabsContent value="sessions">
          <FleetSessionsTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="stations" className="space-y-6">
          <FleetStationsTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="vehicles">
          <FleetVehiclesTab fleetId={fleetId} canManageMembers={canManageMembers} />
        </TabsContent>

        <TabsContent value="drivers" className="space-y-6">
          <FleetDriversTab
            fleetId={fleetId}
            accountBillingEnabled={fleet.accountBillingEnabled === true}
            canManageMembers={canManageMembers}
          />
        </TabsContent>

        <TabsContent value="pricing" className="space-y-6">
          <FleetPricingTab fleetId={fleetId} />
        </TabsContent>

        {hasAllSiteAccess && (
          <TabsContent value="billing" className="space-y-6">
            <FleetBillingTab fleet={fleet} />
            <FleetBillingProfileCard fleet={fleet} />
            <FleetCreditLimitCard fleetId={fleetId} />
            <FleetInvoicesCard fleetId={fleetId} />
          </TabsContent>
        )}

        <TabsContent value="reservations" className="space-y-6">
          <FleetReservationsTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="history">
          <EntityHistoryTab entityType="fleet" entityId={fleetId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
