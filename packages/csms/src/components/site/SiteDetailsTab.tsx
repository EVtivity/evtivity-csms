// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { api } from '@/lib/api';
import { TIMEZONE_OPTIONS, formatDateTime } from '@/lib/timezone';

interface Site {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactIsPublic: boolean;
  hoursOfOperation: string | null;
  reservationsEnabled: boolean;
  freeVendEnabled: boolean;
  freeVendTemplateId21: string | null;
  freeVendTemplateId16: string | null;
  carbonRegionCode: string | null;
  stationCount: number;
  createdAt: string;
  updatedAt: string;
}

interface CarbonFactor {
  id: number;
  regionCode: string;
  regionName: string;
  countryCode: string;
  carbonIntensityKgPerKwh: string;
  source: string;
}

export interface SiteDetailsTabProps {
  site: Site;
  siteId: string;
  googleMapsApiKey: string;
  onDelete: () => void;
  deleteIsPending: boolean;
}

export function SiteDetailsTab({
  site,
  siteId,
  googleMapsApiKey,
  onDelete,
  deleteIsPending,
}: SiteDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [country, setCountry] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [editTimezone, setEditTimezone] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactIsPublic, setContactIsPublic] = useState(false);
  const [hoursOfOperation, setHoursOfOperation] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: carbonFactors } = useQuery({
    queryKey: ['carbon-factors'],
    queryFn: () => api.get<CarbonFactor[]>('/v1/carbon/factors'),
  });

  const carbonRegionMutation = useMutation({
    mutationFn: (regionCode: string | null) =>
      api.put(`/v1/sites/${siteId}/carbon-region`, { regionCode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, string>) => api.patch<Site>(`/v1/sites/${siteId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites', siteId] });
      setEditing(false);
      setHasSubmitted(false);
    },
  });

  function startEdit(): void {
    setName(site.name);
    setAddress(site.address ?? '');
    setCity(site.city ?? '');
    setState(site.state ?? '');
    setPostalCode(site.postalCode ?? '');
    setCountry(site.country ?? '');
    setLatitude(site.latitude ?? '');
    setLongitude(site.longitude ?? '');
    setEditTimezone(site.timezone);
    setContactName(site.contactName ?? '');
    setContactEmail(site.contactEmail ?? '');
    setContactPhone(site.contactPhone ?? '');
    setContactIsPublic(site.contactIsPublic);
    setHoursOfOperation(site.hoursOfOperation ?? '');
    setEditing(true);
  }

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (name.trim() === '') {
      errors.name = t('validation.required');
    }
    return errors;
  }

  const validationErrors = getValidationErrors();

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(validationErrors).length > 0) return;
    const body: Record<string, string> = {};
    if (name !== '') body['name'] = name;
    if (address !== '') body['address'] = address;
    if (city !== '') body['city'] = city;
    if (state !== '') body['state'] = state;
    if (postalCode !== '') body['postalCode'] = postalCode;
    if (country !== '') body['country'] = country;
    if (latitude !== '') body['latitude'] = latitude;
    if (longitude !== '') body['longitude'] = longitude;
    if (editTimezone !== '') body['timezone'] = editTimezone;
    if (contactName !== '') body['contactName'] = contactName;
    if (contactEmail !== '') body['contactEmail'] = contactEmail;
    if (contactPhone !== '') body['contactPhone'] = contactPhone;
    (body as Record<string, unknown>)['contactIsPublic'] = contactIsPublic;
    (body as Record<string, unknown>)['hoursOfOperation'] =
      hoursOfOperation.trim() !== '' ? hoursOfOperation.trim() : null;
    updateMutation.mutate(body);
  }

  return (
    <TabsContent value="details" className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            <RemoveButton
              label={t('common.delete')}
              onClick={onDelete}
              disabled={deleteIsPending || site.stationCount > 0}
              title={site.stationCount > 0 ? t('sites.removeStationsFirst') : ''}
            />
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} noValidate className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-name">{t('common.name')}</Label>
                <Input
                  id="edit-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  className={hasSubmitted && validationErrors.name ? 'border-destructive' : ''}
                />
                {hasSubmitted && validationErrors.name && (
                  <p className="text-sm text-destructive">{validationErrors.name}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-address">{t('sites.address')}</Label>
                <Input
                  id="edit-address"
                  value={address}
                  onChange={(e) => {
                    setAddress(e.target.value);
                  }}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-city">{t('sites.city')}</Label>
                  <Input
                    id="edit-city"
                    value={city}
                    onChange={(e) => {
                      setCity(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-state">{t('sites.state')}</Label>
                  <Input
                    id="edit-state"
                    value={state}
                    onChange={(e) => {
                      setState(e.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-postal">{t('sites.postalCode')}</Label>
                  <Input
                    id="edit-postal"
                    value={postalCode}
                    onChange={(e) => {
                      setPostalCode(e.target.value);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-country">{t('sites.country')}</Label>
                  <Input
                    id="edit-country"
                    value={country}
                    onChange={(e) => {
                      setCountry(e.target.value);
                    }}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-latitude">{t('sites.latitude')}</Label>
                  <Input
                    id="edit-latitude"
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
                  <Label htmlFor="edit-longitude">{t('sites.longitude')}</Label>
                  <Input
                    id="edit-longitude"
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
                <Label htmlFor="edit-timezone">{t('sites.timezone')}</Label>
                <Select
                  id="edit-timezone"
                  value={editTimezone}
                  onChange={(e) => {
                    setEditTimezone(e.target.value);
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
                <Label htmlFor="edit-hours">{t('sites.hoursOfOperation')}</Label>
                <textarea
                  id="edit-hours"
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
                  <Label htmlFor="edit-contact-name">{t('sites.contactName')}</Label>
                  <Input
                    id="edit-contact-name"
                    value={contactName}
                    onChange={(e) => {
                      setContactName(e.target.value);
                    }}
                  />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="edit-contact-email">{t('sites.contactEmail')}</Label>
                    <Input
                      id="edit-contact-email"
                      type="email"
                      value={contactEmail}
                      onChange={(e) => {
                        setContactEmail(e.target.value);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="edit-contact-phone">{t('sites.contactPhone')}</Label>
                    <Input
                      id="edit-contact-phone"
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
                    id="edit-contact-public"
                    checked={contactIsPublic}
                    onChange={(e) => {
                      setContactIsPublic(e.target.checked);
                    }}
                  />
                  <Label htmlFor="edit-contact-public" className="cursor-pointer">
                    {t('sites.contactIsPublic')}
                  </Label>
                </div>
              </div>
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                    setHasSubmitted(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('sites.address')}</dt>
                <dd className="font-medium">{site.address ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.city')}</dt>
                <dd className="font-medium">{site.city ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.state')}</dt>
                <dd className="font-medium">{site.state ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.postalCode')}</dt>
                <dd className="font-medium">{site.postalCode ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.country')}</dt>
                <dd className="font-medium">{site.country ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.latitude')}</dt>
                <dd className="font-medium">{site.latitude ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.longitude')}</dt>
                <dd className="font-medium">{site.longitude ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.timezone')}</dt>
                <dd className="font-medium">{site.timezone}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.hoursOfOperation')}</dt>
                <dd className="font-medium whitespace-pre-line">{site.hoursOfOperation ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(site.createdAt, site.timezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(site.updatedAt, site.timezone)}</dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
      {!editing && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.contact')}</CardTitle>
            <CardDescription>{t('sites.contactPublicNote')}</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('sites.contactName')}</dt>
                <dd className="font-medium">{site.contactName ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.contactEmail')}</dt>
                <dd className="font-medium">{site.contactEmail ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.contactPhone')}</dt>
                <dd className="font-medium">{site.contactPhone ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('sites.contactIsPublic')}</dt>
                <dd className="font-medium">
                  {site.contactIsPublic ? t('common.yes') : t('common.no')}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
      {!editing && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.carbonRegion')}</CardTitle>
            <CardDescription>{t('sites.carbonRegionDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <Select
                aria-label="Carbon region"
                value={site.carbonRegionCode ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  carbonRegionMutation.mutate(val === '' ? null : val);
                }}
                className="h-9 max-w-sm"
              >
                <option value="">{t('sites.noCarbonRegion')}</option>
                {(() => {
                  const grouped: Record<string, CarbonFactor[]> = {};
                  for (const f of carbonFactors ?? []) {
                    const list = grouped[f.countryCode] ?? [];
                    list.push(f);
                    grouped[f.countryCode] = list;
                  }
                  return Object.entries(grouped).map(([groupCountry, factors]) => (
                    <optgroup key={groupCountry} label={groupCountry}>
                      {factors.map((f) => (
                        <option key={f.regionCode} value={f.regionCode}>
                          {f.regionName} ({Math.round(Number(f.carbonIntensityKgPerKwh) * 1000)} g
                          CO2/kWh)
                        </option>
                      ))}
                    </optgroup>
                  ));
                })()}
              </Select>
              {site.carbonRegionCode != null &&
                (() => {
                  const factor = carbonFactors?.find((f) => f.regionCode === site.carbonRegionCode);
                  return factor != null ? (
                    <span className="text-sm text-muted-foreground">
                      {t('sites.carbonIntensity')}:{' '}
                      {Math.round(Number(factor.carbonIntensityKgPerKwh) * 1000)} g CO2/kWh
                    </span>
                  ) : null;
                })()}
            </div>
          </CardContent>
        </Card>
      )}
      {googleMapsApiKey !== '' && site.latitude != null && site.longitude != null && (
        <Card>
          <CardHeader>
            <CardTitle>{t('sites.map')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-hidden rounded-md">
              <iframe
                title={t('sites.map')}
                width="100%"
                height="400"
                style={{ border: 0 }}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(googleMapsApiKey)}&q=${encodeURIComponent(site.latitude)},${encodeURIComponent(site.longitude)}&zoom=15`}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </TabsContent>
  );
}
