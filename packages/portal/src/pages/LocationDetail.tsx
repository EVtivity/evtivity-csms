// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Clock, Mail, MapPin, Phone, User, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AuthBranding, AuthFooter, useAuthBranding } from '@/components/AuthBranding';
import { ImageCarousel } from '@/components/ImageCarousel';
import { LocationMap } from '@/components/LocationMap';
import { PopularTimesChart } from '@/components/PopularTimesChart';
import type { PopularTimesData } from '@/components/PopularTimesChart';
import { api } from '@/lib/api';

interface LocationInfo {
  siteId: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  hoursOfOperation: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  stationCount: number;
  evseCount: number;
  availableCount: number;
}

export function LocationDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { siteId } = useParams<{ siteId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { companyName, companyLogo, branding } = useAuthBranding();

  const from = searchParams.get('from');

  const {
    data: location,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['location-detail', siteId],
    queryFn: () => api.get<LocationInfo>(`/v1/portal/chargers/location/${siteId ?? ''}`),
    enabled: siteId != null,
  });

  const { data: popularTimes } = useQuery({
    queryKey: ['location-popular-times', siteId],
    queryFn: () =>
      api.get<PopularTimesData[]>(
        `/v1/portal/chargers/location/${siteId ?? ''}/popular-times?weeks=4`,
      ),
    enabled: siteId != null,
  });

  function handleBack(): void {
    if (from != null) {
      void navigate(from);
    } else {
      void navigate(-1);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">{t('location.loading')}</p>
      </div>
    );
  }

  if (error != null || location == null) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4">
        <AuthBranding companyName={companyName} companyLogo={companyLogo} />
        <Card className="w-full max-w-sm text-center">
          <CardContent className="p-6">
            <p className="text-destructive">{t('charger.notFound')}</p>
          </CardContent>
        </Card>
        <AuthFooter companyName={companyName} branding={branding} />
      </div>
    );
  }

  const hasCoordinates =
    location.latitude != null &&
    location.longitude != null &&
    location.latitude !== '' &&
    location.longitude !== '';

  const hasContact =
    location.contactName != null || location.contactEmail != null || location.contactPhone != null;

  const fullAddress = [location.address, location.city, location.state, location.postalCode]
    .filter((p) => p != null && p !== '')
    .join(', ');

  return (
    <div className="flex min-h-screen flex-col items-center p-4">
      <AuthBranding companyName={companyName} companyLogo={companyLogo} />
      <div className="w-full max-w-lg space-y-4">
        {/* Header with back button */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="gap-1 px-0" onClick={handleBack}>
            <ArrowLeft className="h-4 w-4" />
            {t('common.back')}
          </Button>
        </div>

        <h1 className="text-2xl font-bold">{location.name ?? t('location.title')}</h1>

        {/* Address */}
        {fullAddress !== '' && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{fullAddress}</span>
          </div>
        )}

        {/* Hours of Operation */}
        {location.hoursOfOperation != null && location.hoursOfOperation !== '' && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-foreground">{t('location.hoursOfOperation')}</p>
              <p className="whitespace-pre-line">{location.hoursOfOperation}</p>
            </div>
          </div>
        )}

        {/* Station count */}
        <div className="flex items-center gap-2 text-sm">
          <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
          <span>
            {t('location.chargers', { count: location.evseCount })}
            {' -- '}
            <span className="text-success font-medium">
              {t('location.available', { count: location.availableCount })}
            </span>
          </span>
        </div>

        {/* Image Carousel */}
        {siteId != null && <ImageCarousel siteId={siteId} />}

        {/* Google Map */}
        {hasCoordinates && (
          <LocationMap
            latitude={location.latitude as string}
            longitude={location.longitude as string}
            name={location.name ?? ''}
          />
        )}

        {/* Popular Times */}
        {popularTimes != null && popularTimes.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('charts.popularTimes')}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <PopularTimesChart data={popularTimes} weeks={4} />
            </CardContent>
          </Card>
        )}

        {/* Contact Info */}
        {hasContact && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('location.contactInfo')}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0 space-y-1.5">
              {location.contactName != null && (
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{location.contactName}</span>
                </div>
              )}
              {location.contactEmail != null && (
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <a
                    href={`mailto:${location.contactEmail}`}
                    className="text-primary hover:underline"
                  >
                    {location.contactEmail}
                  </a>
                </div>
              )}
              {location.contactPhone != null && (
                <div className="flex items-center gap-2 text-sm">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <a href={`tel:${location.contactPhone}`} className="text-primary hover:underline">
                    {location.contactPhone}
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
      <AuthFooter companyName={companyName} branding={branding} />
    </div>
  );
}
