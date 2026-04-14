// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { TIMEZONE_OPTIONS } from '@/lib/timezone';

interface Site {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
}

export function SiteCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactIsPublic, setContactIsPublic] = useState(false);
  const [hoursOfOperation, setHoursOfOperation] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: Record<string, string>) => api.post<Site>('/v1/sites', body),
    onSuccess: (created) => {
      void navigate(`/sites/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, string> = { name };
    if (address.trim() !== '') body['address'] = address;
    if (city.trim() !== '') body['city'] = city;
    if (state.trim() !== '') body['state'] = state;
    if (postalCode.trim() !== '') body['postalCode'] = postalCode;
    if (country.trim() !== '') body['country'] = country;
    if (latitude.trim() !== '') body['latitude'] = latitude;
    if (longitude.trim() !== '') body['longitude'] = longitude;
    body['timezone'] = timezone;
    if (contactName.trim() !== '') body['contactName'] = contactName;
    if (contactEmail.trim() !== '') body['contactEmail'] = contactEmail;
    if (contactPhone.trim() !== '') body['contactPhone'] = contactPhone;
    (body as Record<string, unknown>)['contactIsPublic'] = contactIsPublic;
    if (hoursOfOperation.trim() !== '') body['hoursOfOperation'] = hoursOfOperation.trim();
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/sites" />
        <h1 className="text-2xl md:text-3xl font-bold">{t('sites.createSite')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="site-name">{t('common.name')}</Label>
              <Input
                id="site-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
                className={hasSubmitted && errors.name ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.name && (
                <p className="text-sm text-destructive">{errors.name}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-address">{t('sites.address')}</Label>
              <Input
                id="site-address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                }}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="site-city">{t('sites.city')}</Label>
                <Input
                  id="site-city"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-state">{t('sites.state')}</Label>
                <Input
                  id="site-state"
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="site-postal">{t('sites.postalCode')}</Label>
                <Input
                  id="site-postal"
                  value={postalCode}
                  onChange={(e) => {
                    setPostalCode(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-country">{t('sites.country')}</Label>
                <Input
                  id="site-country"
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="site-latitude">{t('sites.latitude')}</Label>
                <Input
                  id="site-latitude"
                  type="number"
                  step="any"
                  placeholder="e.g. 40.7128"
                  value={latitude}
                  onChange={(e) => {
                    setLatitude(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-longitude">{t('sites.longitude')}</Label>
                <Input
                  id="site-longitude"
                  type="number"
                  step="any"
                  placeholder="e.g. -74.0060"
                  value={longitude}
                  onChange={(e) => {
                    setLongitude(e.target.value);
                  }}
                />
              </div>
            </div>
            <GoogleMapPicker
              latitude={latitude}
              longitude={longitude}
              onLocationChange={(lat, lng) => {
                setLatitude(lat);
                setLongitude(lng);
              }}
            />
            <div className="space-y-2">
              <Label htmlFor="site-timezone">{t('sites.timezone')}</Label>
              <Select
                id="site-timezone"
                value={timezone}
                onChange={(e) => {
                  setTimezone(e.target.value);
                }}
                className="h-9"
              >
                {TIMEZONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} ({opt.value})
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="site-hours">{t('sites.hoursOfOperation')}</Label>
              <textarea
                id="site-hours"
                value={hoursOfOperation}
                onChange={(e) => {
                  setHoursOfOperation(e.target.value);
                }}
                placeholder={t('sites.hoursOfOperationPlaceholder')}
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
            <div className="border-t pt-4 space-y-4">
              <div>
                <p className="text-sm font-medium">{t('sites.contact')}</p>
                <p className="text-xs text-muted-foreground">{t('sites.contactPublicNote')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="site-contact-name">{t('sites.contactName')}</Label>
                <Input
                  id="site-contact-name"
                  value={contactName}
                  onChange={(e) => {
                    setContactName(e.target.value);
                  }}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="site-contact-email">{t('sites.contactEmail')}</Label>
                  <Input
                    id="site-contact-email"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => {
                      setContactEmail(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="site-contact-phone">{t('sites.contactPhone')}</Label>
                  <Input
                    id="site-contact-phone"
                    type="tel"
                    value={contactPhone}
                    onChange={(e) => {
                      setContactPhone(e.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="site-contact-public"
                  checked={contactIsPublic}
                  onChange={(e) => {
                    setContactIsPublic(e.target.checked);
                  }}
                />
                <Label htmlFor="site-contact-public" className="cursor-pointer">
                  {t('sites.contactIsPublic')}
                </Label>
              </div>
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/sites');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
