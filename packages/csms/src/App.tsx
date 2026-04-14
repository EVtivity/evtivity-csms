// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/query';
import { useAuth } from '@/lib/auth';
import { ServerDown } from '@/components/ServerDown';
import { useGtag } from '@/hooks/use-gtag';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/ui/toast';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AdminRoute } from '@/components/AdminRoute';
import { Login } from '@/pages/Login';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import { SetPassword } from '@/pages/SetPassword';

const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Sites = lazy(() => import('@/pages/Sites').then((m) => ({ default: m.Sites })));
const SiteCreate = lazy(() =>
  import('@/pages/SiteCreate').then((m) => ({ default: m.SiteCreate })),
);
const SiteDetail = lazy(() =>
  import('@/pages/SiteDetail').then((m) => ({ default: m.SiteDetail })),
);
const Stations = lazy(() => import('@/pages/Stations').then((m) => ({ default: m.Stations })));
const StationCreate = lazy(() =>
  import('@/pages/StationCreate').then((m) => ({ default: m.StationCreate })),
);
const StationDetail = lazy(() =>
  import('@/pages/StationDetail').then((m) => ({ default: m.StationDetail })),
);
const Sessions = lazy(() => import('@/pages/Sessions').then((m) => ({ default: m.Sessions })));
const Drivers = lazy(() => import('@/pages/Drivers').then((m) => ({ default: m.Drivers })));
const DriverCreate = lazy(() =>
  import('@/pages/DriverCreate').then((m) => ({ default: m.DriverCreate })),
);
const DriverDetail = lazy(() =>
  import('@/pages/DriverDetail').then((m) => ({ default: m.DriverDetail })),
);
const Pricing = lazy(() => import('@/pages/Pricing').then((m) => ({ default: m.Pricing })));
const PricingGroupCreate = lazy(() =>
  import('@/pages/PricingGroupCreate').then((m) => ({ default: m.PricingGroupCreate })),
);
const PricingGroupDetail = lazy(() =>
  import('@/pages/PricingGroupDetail').then((m) => ({ default: m.PricingGroupDetail })),
);
const TariffCreate = lazy(() =>
  import('@/pages/TariffCreate').then((m) => ({ default: m.TariffCreate })),
);
const TariffDetail = lazy(() =>
  import('@/pages/TariffDetail').then((m) => ({ default: m.TariffDetail })),
);
const PricingHolidays = lazy(() =>
  import('@/pages/PricingHolidays').then((m) => ({ default: m.PricingHolidays })),
);
const UsersPage = lazy(() => import('@/pages/Users').then((m) => ({ default: m.UsersPage })));
const UserCreate = lazy(() =>
  import('@/pages/UserCreate').then((m) => ({ default: m.UserCreate })),
);
const UserDetail = lazy(() =>
  import('@/pages/UserDetail').then((m) => ({ default: m.UserDetail })),
);
const SessionDetail = lazy(() =>
  import('@/pages/SessionDetail').then((m) => ({ default: m.SessionDetail })),
);
const Fleets = lazy(() => import('@/pages/Fleets').then((m) => ({ default: m.Fleets })));
const FleetCreate = lazy(() =>
  import('@/pages/FleetCreate').then((m) => ({ default: m.FleetCreate })),
);
const FleetDetail = lazy(() =>
  import('@/pages/FleetDetail').then((m) => ({ default: m.FleetDetail })),
);
const FleetAddDriver = lazy(() =>
  import('@/pages/FleetAddDriver').then((m) => ({ default: m.FleetAddDriver })),
);
const FleetAddStation = lazy(() =>
  import('@/pages/FleetAddStation').then((m) => ({ default: m.FleetAddStation })),
);
const FleetAssignPricing = lazy(() =>
  import('@/pages/FleetAssignPricing').then((m) => ({ default: m.FleetAssignPricing })),
);
const SiteAssignPricing = lazy(() =>
  import('@/pages/SiteAssignPricing').then((m) => ({ default: m.SiteAssignPricing })),
);
const StationAssignPricing = lazy(() =>
  import('@/pages/StationAssignPricing').then((m) => ({ default: m.StationAssignPricing })),
);
const DriverAssignPricing = lazy(() =>
  import('@/pages/DriverAssignPricing').then((m) => ({ default: m.DriverAssignPricing })),
);
const DriverTokenCreate = lazy(() =>
  import('@/pages/DriverTokenCreate').then((m) => ({ default: m.DriverTokenCreate })),
);
const VehicleCreate = lazy(() =>
  import('@/pages/VehicleCreate').then((m) => ({ default: m.VehicleCreate })),
);
const VehicleDetail = lazy(() =>
  import('@/pages/VehicleDetail').then((m) => ({ default: m.VehicleDetail })),
);
const FleetAddVehicle = lazy(() =>
  import('@/pages/FleetAddVehicle').then((m) => ({ default: m.FleetAddVehicle })),
);
const Tokens = lazy(() => import('@/pages/Tokens').then((m) => ({ default: m.Tokens })));
const TokenCreate = lazy(() =>
  import('@/pages/TokenCreate').then((m) => ({ default: m.TokenCreate })),
);
const TokenDetail = lazy(() =>
  import('@/pages/TokenDetail').then((m) => ({ default: m.TokenDetail })),
);
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })));
const NotificationRules = lazy(() =>
  import('@/pages/NotificationRules').then((m) => ({ default: m.NotificationRules })),
);
const Reservations = lazy(() =>
  import('@/pages/Reservations').then((m) => ({ default: m.Reservations })),
);
const ReservationCreate = lazy(() =>
  import('@/pages/ReservationCreate').then((m) => ({ default: m.ReservationCreate })),
);
const ReservationDetail = lazy(() =>
  import('@/pages/ReservationDetail').then((m) => ({ default: m.ReservationDetail })),
);
const AccessLogs = lazy(() =>
  import('@/pages/AccessLogs').then((m) => ({ default: m.AccessLogs })),
);
const Reports = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.Reports })));
const Profile = lazy(() => import('@/pages/Profile').then((m) => ({ default: m.Profile })));
const SupportCases = lazy(() =>
  import('@/pages/SupportCases').then((m) => ({ default: m.SupportCases })),
);
const SupportCaseCreate = lazy(() =>
  import('@/pages/SupportCaseCreate').then((m) => ({ default: m.SupportCaseCreate })),
);
const SupportCaseDetail = lazy(() =>
  import('@/pages/SupportCaseDetail').then((m) => ({ default: m.SupportCaseDetail })),
);
const RoamingLayout = lazy(() =>
  import('@/pages/RoamingLayout').then((m) => ({ default: m.RoamingLayout })),
);
const RoamingPartners = lazy(() =>
  import('@/pages/RoamingPartners').then((m) => ({ default: m.RoamingPartners })),
);
const RoamingPartnerCreate = lazy(() =>
  import('@/pages/RoamingPartnerCreate').then((m) => ({ default: m.RoamingPartnerCreate })),
);
const RoamingPartnerDetail = lazy(() =>
  import('@/pages/RoamingPartnerDetail').then((m) => ({ default: m.RoamingPartnerDetail })),
);
const RoamingLocations = lazy(() =>
  import('@/pages/RoamingLocations').then((m) => ({ default: m.RoamingLocations })),
);
const RoamingSessions = lazy(() =>
  import('@/pages/RoamingSessions').then((m) => ({ default: m.RoamingSessions })),
);
const RoamingCdrs = lazy(() =>
  import('@/pages/RoamingCdrs').then((m) => ({ default: m.RoamingCdrs })),
);
const RoamingTariffs = lazy(() =>
  import('@/pages/RoamingTariffs').then((m) => ({ default: m.RoamingTariffs })),
);
const RoamingTariffMappingCreate = lazy(() =>
  import('@/pages/RoamingTariffMappingCreate').then((m) => ({
    default: m.RoamingTariffMappingCreate,
  })),
);
const RoamingTariffMappingDetail = lazy(() =>
  import('@/pages/RoamingTariffMappingDetail').then((m) => ({
    default: m.RoamingTariffMappingDetail,
  })),
);
const FirmwareCampaignCreate = lazy(() =>
  import('@/pages/FirmwareCampaignCreate').then((m) => ({
    default: m.FirmwareCampaignCreate,
  })),
);
const FirmwareCampaignDetail = lazy(() =>
  import('@/pages/FirmwareCampaignDetail').then((m) => ({
    default: m.FirmwareCampaignDetail,
  })),
);
const SmartChargingTemplates = lazy(() =>
  import('@/pages/SmartChargingTemplates').then((m) => ({
    default: m.SmartChargingTemplates,
  })),
);
const SmartChargingTemplateCreate = lazy(() =>
  import('@/pages/SmartChargingTemplateCreate').then((m) => ({
    default: m.SmartChargingTemplateCreate,
  })),
);
const SmartChargingTemplateDetail = lazy(() =>
  import('@/pages/SmartChargingTemplateDetail').then((m) => ({
    default: m.SmartChargingTemplateDetail,
  })),
);
const SmartChargingPushDetail = lazy(() =>
  import('@/pages/SmartChargingPushDetail').then((m) => ({
    default: m.SmartChargingPushDetail,
  })),
);
const ConfigTemplateCreate = lazy(() =>
  import('@/pages/ConfigTemplateCreate').then((m) => ({ default: m.ConfigTemplateCreate })),
);
const ConfigTemplateDetail = lazy(() =>
  import('@/pages/ConfigTemplateDetail').then((m) => ({ default: m.ConfigTemplateDetail })),
);
const ConfigTemplatePushDetail = lazy(() =>
  import('@/pages/ConfigTemplatePushDetail').then((m) => ({
    default: m.ConfigTemplatePushDetail,
  })),
);
const ConformanceDetail = lazy(() =>
  import('@/pages/ConformanceDetail').then((m) => ({ default: m.ConformanceDetail })),
);
const Certificates = lazy(() =>
  import('@/pages/Certificates').then((m) => ({ default: m.Certificates })),
);
const PrivacyPolicy = lazy(() =>
  import('@/pages/PrivacyPolicy').then((m) => ({ default: m.PrivacyPolicy })),
);
const TermsOfService = lazy(() =>
  import('@/pages/TermsOfService').then((m) => ({ default: m.TermsOfService })),
);
const NotFound = lazy(() => import('@/pages/NotFound').then((m) => ({ default: m.NotFound })));

const SuspenseFallback = (
  <div className="flex items-center justify-center h-32">
    <p className="text-muted-foreground">Loading...</p>
  </div>
);

function GtagLoader(): null {
  useGtag();
  return null;
}

export function App(): React.JSX.Element {
  const hydrate = useAuth((s) => s.hydrate);
  const apiDown = useAuth((s) => s.apiDown);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  if (apiDown) {
    return <ServerDown />;
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <GtagLoader />
          <BrowserRouter>
            <Suspense fallback={SuspenseFallback}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/forgot-password" element={<ForgotPassword />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                <Route path="/set-password" element={<SetPassword />} />
                <Route path="/privacy-policy" element={<PrivacyPolicy />} />
                <Route path="/terms-of-service" element={<TermsOfService />} />
                <Route
                  element={
                    <ProtectedRoute>
                      <Layout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<Dashboard />} />
                  <Route path="sites" element={<Sites />} />
                  <Route path="sites/new" element={<SiteCreate />} />
                  <Route path="sites/:id" element={<SiteDetail />} />
                  <Route path="sites/:id/pricing/add" element={<SiteAssignPricing />} />
                  <Route path="stations" element={<Stations />} />
                  <Route path="stations/new" element={<StationCreate />} />
                  <Route path="stations/:id" element={<StationDetail />} />
                  <Route path="stations/:id/pricing/add" element={<StationAssignPricing />} />
                  <Route path="sessions" element={<Sessions />} />
                  <Route path="sessions/:id" element={<SessionDetail />} />
                  <Route path="reservations" element={<Reservations />} />
                  <Route path="reservations/new" element={<ReservationCreate />} />
                  <Route path="reservations/:id" element={<ReservationDetail />} />
                  <Route path="drivers" element={<Drivers />} />
                  <Route path="drivers/new" element={<DriverCreate />} />
                  <Route path="drivers/:id" element={<DriverDetail />} />
                  <Route path="drivers/:id/pricing/add" element={<DriverAssignPricing />} />
                  <Route path="drivers/:id/tokens/new" element={<DriverTokenCreate />} />
                  <Route path="drivers/:id/vehicles/new" element={<VehicleCreate />} />
                  <Route path="drivers/:id/vehicles/:vehicleId" element={<VehicleDetail />} />
                  <Route path="pricing" element={<Pricing />} />
                  <Route path="pricing/new" element={<PricingGroupCreate />} />
                  <Route path="pricing/holidays" element={<PricingHolidays />} />
                  <Route path="pricing/:id" element={<PricingGroupDetail />} />
                  <Route path="pricing/:id/tariffs/new" element={<TariffCreate />} />
                  <Route path="pricing/:id/tariffs/:tariffId" element={<TariffDetail />} />
                  <Route path="fleets" element={<Fleets />} />
                  <Route path="fleets/new" element={<FleetCreate />} />
                  <Route path="fleets/:id" element={<FleetDetail />} />
                  <Route path="fleets/:id/vehicles/add" element={<FleetAddVehicle />} />
                  <Route path="fleets/:id/drivers/add" element={<FleetAddDriver />} />
                  <Route path="fleets/:id/stations/add" element={<FleetAddStation />} />
                  <Route path="fleets/:id/pricing/add" element={<FleetAssignPricing />} />
                  <Route path="tokens" element={<Tokens />} />
                  <Route path="tokens/new" element={<TokenCreate />} />
                  <Route path="tokens/:id" element={<TokenDetail />} />
                  <Route
                    path="users"
                    element={
                      <AdminRoute requiredPermission="users:read">
                        <UsersPage />
                      </AdminRoute>
                    }
                  />
                  <Route
                    path="users/new"
                    element={
                      <AdminRoute requiredPermission="users:write">
                        <UserCreate />
                      </AdminRoute>
                    }
                  />
                  <Route
                    path="users/:id"
                    element={
                      <AdminRoute requiredPermission="users:read">
                        <UserDetail />
                      </AdminRoute>
                    }
                  />
                  <Route
                    path="reports"
                    element={
                      <AdminRoute requiredPermission="reports:read">
                        <Reports />
                      </AdminRoute>
                    }
                  />
                  <Route path="support-cases" element={<SupportCases />} />
                  <Route path="support-cases/new" element={<SupportCaseCreate />} />
                  <Route path="support-cases/:id" element={<SupportCaseDetail />} />
                  <Route path="roaming" element={<RoamingLayout />}>
                    <Route index element={<RoamingPartners />} />
                    <Route path="partners" element={<RoamingPartners />} />
                    <Route path="locations" element={<RoamingLocations />} />
                    <Route path="sessions" element={<RoamingSessions />} />
                    <Route path="cdrs" element={<RoamingCdrs />} />
                    <Route path="tariffs" element={<RoamingTariffs />} />
                  </Route>
                  <Route path="roaming/partners/new" element={<RoamingPartnerCreate />} />
                  <Route path="roaming/partners/:id" element={<RoamingPartnerDetail />} />
                  <Route path="roaming/tariffs/new" element={<RoamingTariffMappingCreate />} />
                  <Route path="roaming/tariffs/:id" element={<RoamingTariffMappingDetail />} />
                  <Route path="firmware-campaigns/new" element={<FirmwareCampaignCreate />} />
                  <Route path="firmware-campaigns/:id" element={<FirmwareCampaignDetail />} />
                  <Route path="smart-charging" element={<SmartChargingTemplates />} />
                  <Route path="smart-charging/new" element={<SmartChargingTemplateCreate />} />
                  <Route path="smart-charging/:id" element={<SmartChargingTemplateDetail />} />
                  <Route
                    path="smart-charging/pushes/:pushId"
                    element={<SmartChargingPushDetail />}
                  />
                  <Route path="station-configurations/new" element={<ConfigTemplateCreate />} />
                  <Route path="station-configurations/:id" element={<ConfigTemplateDetail />} />
                  <Route
                    path="station-configuration-pushes/:pushId"
                    element={<ConfigTemplatePushDetail />}
                  />
                  <Route path="conformance/:runId" element={<ConformanceDetail />} />
                  <Route path="certificates" element={<Certificates />} />
                  <Route path="notifications" element={<NotificationRules />} />
                  <Route path="logs" element={<AccessLogs />} />
                  <Route
                    path="settings"
                    element={
                      <AdminRoute>
                        <Settings />
                      </AdminRoute>
                    }
                  />

                  <Route path="profile" element={<Profile />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
