// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FleetDetailsTab } from '@/components/fleet/FleetDetailsTab';
import { FleetSessionsTab } from '@/components/fleet/FleetSessionsTab';
import { FleetStationsTab } from '@/components/fleet/FleetStationsTab';
import { FleetVehiclesTab } from '@/components/fleet/FleetVehiclesTab';
import { FleetDriversTab } from '@/components/fleet/FleetDriversTab';
import { FleetPricingTab } from '@/components/fleet/FleetPricingTab';
import { FleetReservationsTab } from '@/components/fleet/FleetReservationsTab';
import { api } from '@/lib/api';

interface Fleet {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export function FleetDetail(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useTab('details');

  const { data: fleet, isLoading } = useQuery({
    queryKey: ['fleets', id],
    queryFn: () => api.get<Fleet>(`/v1/fleets/${id ?? ''}`),
    enabled: id != null,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (fleet == null) {
    return <p className="text-destructive">{t('fleets.fleetNotFound')}</p>;
  }

  const fleetId = id ?? '';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/fleets" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{fleet.name}</h1>
          <CopyableId id={fleet.id} />
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          <TabsTrigger value="stations">{t('fleets.stations')}</TabsTrigger>
          <TabsTrigger value="vehicles">{t('fleets.vehicles')}</TabsTrigger>
          <TabsTrigger value="drivers">{t('fleets.drivers')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('fleets.pricing')}</TabsTrigger>
          <TabsTrigger value="reservations">{t('fleets.bulkReservations')}</TabsTrigger>
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
          <FleetVehiclesTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="drivers" className="space-y-6">
          <FleetDriversTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="pricing" className="space-y-6">
          <FleetPricingTab fleetId={fleetId} />
        </TabsContent>

        <TabsContent value="reservations" className="space-y-6">
          <FleetReservationsTab fleetId={fleetId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
