// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams, useNavigate } from 'react-router-dom';
import { useTab } from '@/hooks/use-tab';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CopyableId } from '@/components/copyable-id';
import { CreateButton } from '@/components/create-button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SessionsTable, type Session } from '@/components/SessionsTable';
import { TokensTable } from '@/components/TokensTable';
import { VehiclesTable, type Vehicle } from '@/components/VehiclesTable';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useUserTimezone } from '@/lib/timezone';
import { DriverDetailsTab } from '@/components/driver/DriverDetailsTab';
import { DriverPaymentMethodsTab } from '@/components/driver/DriverPaymentMethodsTab';
import { DriverPricingTab } from '@/components/driver/DriverPricingTab';

interface Driver {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DriverToken {
  id: string;
  driverId: string;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  createdAt: string;
}

export function DriverDetail(): React.JSX.Element {
  const timezone = useUserTimezone();
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [tab, setTab] = useTab('details');

  const { data: driver, isLoading } = useQuery({
    queryKey: ['drivers', id],
    queryFn: () => api.get<Driver>(`/v1/drivers/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: tokens } = useQuery({
    queryKey: ['drivers', id, 'tokens'],
    queryFn: () => api.get<DriverToken[]>(`/v1/drivers/${id ?? ''}/tokens`),
    enabled: id != null,
  });

  const {
    data: sessions,
    page: sessionsPage,
    totalPages: sessionsTotalPages,
    setPage: setSessionsPage,
  } = usePaginatedQuery<Session>('driver-sessions', `/v1/drivers/${id ?? ''}/sessions`);

  const { data: driverVehicles } = useQuery({
    queryKey: ['drivers', id, 'vehicles'],
    queryFn: () => api.get<Vehicle[]>(`/v1/drivers/${id ?? ''}/vehicles`),
    enabled: id != null,
  });

  if (isLoading) {
    return <p className="text-muted-foreground">{t('common.loading')}</p>;
  }

  if (driver == null) {
    return <p className="text-destructive">{t('drivers.driverNotFound')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/drivers" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            {driver.firstName} {driver.lastName}
          </h1>
          <CopyableId id={driver.id} />
        </div>
        <Badge variant={driver.isActive ? 'default' : 'outline'}>
          {driver.isActive ? t('common.active') : t('common.inactive')}
        </Badge>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="tokens">{t('tokens.title')}</TabsTrigger>
          <TabsTrigger value="payment-methods">{t('payments.paymentMethods')}</TabsTrigger>
          <TabsTrigger value="vehicles">{t('vehicles.title')}</TabsTrigger>
          <TabsTrigger value="sessions">{t('sessions.title')}</TabsTrigger>
          <TabsTrigger value="pricing">{t('drivers.pricing')}</TabsTrigger>
        </TabsList>

        <DriverDetailsTab driver={driver} timezone={timezone} />

        <TabsContent value="tokens">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('tokens.title')}</CardTitle>
              <CreateButton
                label={t('tokens.createToken')}
                onClick={() => {
                  void navigate(`/drivers/${id ?? ''}/tokens/new`);
                }}
              />
            </CardHeader>
            <CardContent>
              <TokensTable
                tokens={tokens}
                page={1}
                totalPages={1}
                onPageChange={() => {}}
                timezone={timezone}
                showDriver={false}
                emptyMessage={t('tokens.noTokens')}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <DriverPaymentMethodsTab driverId={id ?? ''} timezone={timezone} />

        <TabsContent value="vehicles">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{t('vehicles.title')}</CardTitle>
              <CreateButton
                label={t('vehicles.createVehicle')}
                onClick={() => {
                  void navigate(`/drivers/${id ?? ''}/vehicles/new`);
                }}
              />
            </CardHeader>
            <CardContent>
              <VehiclesTable
                vehicles={driverVehicles}
                page={1}
                totalPages={1}
                onPageChange={() => {}}
                onRowClick={(vehicle) => {
                  void navigate(`/drivers/${id ?? ''}/vehicles/${vehicle.id}`);
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle>{t('sessions.title')}</CardTitle>
            </CardHeader>
            <CardContent>
              <SessionsTable
                sessions={sessions}
                page={sessionsPage}
                totalPages={sessionsTotalPages}
                onPageChange={setSessionsPage}
                timezone={timezone}
                hideDriverName
              />
            </CardContent>
          </Card>
        </TabsContent>

        <DriverPricingTab driverId={id ?? ''} />
      </Tabs>
    </div>
  );
}
