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
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { VerifiedRoute } from '@/components/VerifiedRoute';
import { Login } from '@/pages/Login';
import { Register } from '@/pages/Register';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';

const VerifyEmail = lazy(() =>
  import('@/pages/VerifyEmail').then((m) => ({ default: m.VerifyEmail })),
);
const Home = lazy(() => import('@/pages/Home').then((m) => ({ default: m.Home })));
const Sessions = lazy(() => import('@/pages/Sessions').then((m) => ({ default: m.Sessions })));
const SessionDetail = lazy(() =>
  import('@/pages/SessionDetail').then((m) => ({ default: m.SessionDetail })),
);
const Activity = lazy(() => import('@/pages/Activity').then((m) => ({ default: m.Activity })));
const MonthlyStatement = lazy(() =>
  import('@/pages/MonthlyStatement').then((m) => ({ default: m.MonthlyStatement })),
);
const Account = lazy(() => import('@/pages/Account').then((m) => ({ default: m.Account })));
const PaymentMethods = lazy(() =>
  import('@/pages/PaymentMethods').then((m) => ({ default: m.PaymentMethods })),
);
const Profile = lazy(() => import('@/pages/Profile').then((m) => ({ default: m.Profile })));
const ChargerLanding = lazy(() =>
  import('@/pages/ChargerLanding').then((m) => ({ default: m.ChargerLanding })),
);
const ChargerStationLanding = lazy(() =>
  import('@/pages/ChargerStationLanding').then((m) => ({
    default: m.ChargerStationLanding,
  })),
);
const GuestCheckout = lazy(() =>
  import('@/pages/GuestCheckout').then((m) => ({ default: m.GuestCheckout })),
);
const GuestSession = lazy(() =>
  import('@/pages/GuestSession').then((m) => ({ default: m.GuestSession })),
);
const ChargerSearch = lazy(() =>
  import('@/pages/ChargerSearch').then((m) => ({ default: m.ChargerSearch })),
);
const ChargerDetail = lazy(() =>
  import('@/pages/ChargerDetail').then((m) => ({ default: m.ChargerDetail })),
);
const Reservations = lazy(() =>
  import('@/pages/Reservations').then((m) => ({ default: m.Reservations })),
);
const RfidCards = lazy(() => import('@/pages/RfidCards').then((m) => ({ default: m.RfidCards })));
const Vehicles = lazy(() => import('@/pages/Vehicles').then((m) => ({ default: m.Vehicles })));
const Favorites = lazy(() => import('@/pages/Favorites').then((m) => ({ default: m.Favorites })));
const SupportCases = lazy(() =>
  import('@/pages/SupportCases').then((m) => ({ default: m.SupportCases })),
);
const SupportCaseDetail = lazy(() =>
  import('@/pages/SupportCaseDetail').then((m) => ({ default: m.SupportCaseDetail })),
);
const NewSupportCase = lazy(() =>
  import('@/pages/NewSupportCase').then((m) => ({ default: m.NewSupportCase })),
);
const PrivacyPolicy = lazy(() =>
  import('@/pages/PrivacyPolicy').then((m) => ({ default: m.PrivacyPolicy })),
);
const TermsOfService = lazy(() =>
  import('@/pages/TermsOfService').then((m) => ({ default: m.TermsOfService })),
);
const LocationDetail = lazy(() =>
  import('@/pages/LocationDetail').then((m) => ({ default: m.LocationDetail })),
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
        <GtagLoader />
        <BrowserRouter>
          <Suspense fallback={SuspenseFallback}>
            <Routes>
              {/* Public routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/terms-of-service" element={<TermsOfService />} />
              <Route path="/charge/:stationId/:evseId" element={<ChargerLanding />} />
              <Route path="/charge/:stationId" element={<ChargerStationLanding />} />
              <Route path="/charge/:stationId/:evseId/checkout" element={<GuestCheckout />} />
              <Route path="/guest-session/:sessionToken" element={<GuestSession />} />
              <Route path="/location/:siteId" element={<LocationDetail />} />

              {/* Authenticated routes */}
              <Route
                element={
                  <ProtectedRoute>
                    <Layout />
                  </ProtectedRoute>
                }
              >
                {/* Accessible without verified email */}
                <Route path="verify-email" element={<VerifyEmail />} />

                {/* Requires verified email */}
                <Route element={<VerifiedRoute />}>
                  <Route index element={<Home />} />
                  <Route path="activity" element={<Activity />} />
                  <Route path="activity/statement" element={<MonthlyStatement />} />
                  <Route path="account" element={<Account />} />
                  <Route path="sessions" element={<Sessions />} />
                  <Route path="sessions/:id" element={<SessionDetail />} />
                  <Route path="reservations" element={<Reservations />} />
                  <Route path="support" element={<SupportCases />} />
                  <Route path="support/new" element={<NewSupportCase />} />
                  <Route path="support/:id" element={<SupportCaseDetail />} />
                  <Route path="payment-methods" element={<PaymentMethods />} />
                  <Route path="rfid-cards" element={<RfidCards />} />
                  <Route path="vehicles" element={<Vehicles />} />
                  <Route path="favorites" element={<Favorites />} />
                  <Route path="profile" element={<Profile />} />
                  <Route path="start" element={<ChargerSearch />} />
                  <Route path="start/:stationId" element={<ChargerDetail />} />
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
