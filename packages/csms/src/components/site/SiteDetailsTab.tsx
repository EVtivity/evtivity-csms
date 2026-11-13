// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { DecimalInput } from '@/components/ui/decimal-input';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TabPanel } from '@/components/ui/tab-panel';
import { TabsContent } from '@/components/ui/tabs';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { LANGUAGES } from '@/components/ui/language-select';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { HoursOfOperationField } from '@/components/site/HoursOfOperationField';
import { SiteAiInsightsRow } from '@/components/site/SiteAiInsightsRow';
import {
  NO_POWER_EQUIPMENT,
  chargerPlacementOf,
  effectiveLayoutSettings,
  placePowerEquipment,
  positionToBay,
  siteTypeOf,
  type ChargerPlacement,
  type LayoutPowerEquipment,
  type SiteLayoutSettings,
  type SiteType,
} from '@evtivity/lib/site-layout';
import { SiteTypeField } from '@/components/site/SiteTypeField';
import type { LayoutStation } from '@/components/layout/StationCard';
import { layoutStationCountsOf } from '@/components/layout/site-layout-free';
import {
  CHARGER_PLACEMENT_LABEL,
  SITE_TYPE_LABEL,
  layoutSummary,
} from '@/components/site/site-type';
import type { SiteAiInsightsState } from '@/components/site/SiteAiInsightsRow';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { useSavedToast } from '@/components/saved-message';
import { TIMEZONE_OPTIONS, formatDateTime } from '@/lib/timezone';

interface Site extends SiteAiInsightsState {
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
  stationMessageLanguage: string | null;
  stationCount: number;
  /** Stored layout settings, null when never saved (the default parking lot shows). */
  layoutSettings?: SiteLayoutSettings | null;
  /** The site's transformers and energy assets (GET /v1/sites/{id}). */
  powerEquipment?: LayoutPowerEquipment;
  createdAt: string;
  updatedAt: string;
}

export interface SiteDetailsTabProps {
  site: Site;
  siteId: string;
  googleMapsApiKey: string;
  onDelete: () => void;
  deleteIsPending: boolean;
  /** The failed delete (409 when the site has stations or payments), shown in the dialog. */
  deleteError?: unknown;
}

export function SiteDetailsTab({
  site,
  siteId,
  googleMapsApiKey,
  onDelete,
  deleteIsPending,
  deleteError,
}: SiteDetailsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const savedToast = useSavedToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('sites:write');
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  const [siteType, setSiteType] = useState<SiteType>('parking_lot');
  const [placement, setPlacement] = useState<ChargerPlacement>('islands');

  // A site that never saved a layout shows the default lot grown to hold its
  // stations, so its summary reads the station positions (the Layout tab's
  // query); a depot reads its stations' connectors (bus bays and truck lanes
  // follow them until a layout Save stores the counts).
  const storedLayout = site.layoutSettings ?? null;
  const readsStations = storedLayout == null || siteTypeOf(storedLayout) === 'depot';
  const { data: layoutStations } = useQuery({
    queryKey: ['sites', siteId, 'layout'],
    queryFn: () => api.get<LayoutStation[]>(`/v1/sites/${siteId}/layout`),
    enabled: readsStations && site.stationCount > 0,
  });
  const layout = useMemo(
    () =>
      placePowerEquipment(
        effectiveLayoutSettings(
          storedLayout,
          (layoutStations ?? []).map((s) => positionToBay({ x: s.positionX, y: s.positionY })),
          layoutStations != null ? layoutStationCountsOf(layoutStations) : site.stationCount,
        ),
        site.powerEquipment ?? NO_POWER_EQUIPMENT,
      ),
    [storedLayout, layoutStations, site.stationCount, site.powerEquipment],
  );

  const stationMessageLanguageMutation = useMutation({
    mutationFn: (language: string | null) =>
      api.patch<Site>(`/v1/sites/${siteId}`, { stationMessageLanguage: language }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Site>(`/v1/sites/${siteId}`, body),
    onSuccess: () => {
      savedToast();
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
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
    setSiteType(siteTypeOf(layout));
    setPlacement(chargerPlacementOf(layout));
    updateMutation.reset();
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
    // An emptied field is sent as null so the site forgets it (a removed
    // contact email or phone must not stay public).
    const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());
    const body: Record<string, unknown> = {
      name,
      address: orNull(address),
      city: orNull(city),
      state: orNull(state),
      postalCode: orNull(postalCode),
      country: orNull(country),
      latitude: orNull(latitude),
      longitude: orNull(longitude),
      contactName: orNull(contactName),
      contactEmail: orNull(contactEmail),
      contactPhone: orNull(contactPhone),
      contactIsPublic,
      hoursOfOperation: orNull(hoursOfOperation),
    };
    if (editTimezone !== '') body['timezone'] = editTimezone;
    if (siteType !== siteTypeOf(layout)) body['siteType'] = siteType;
    // A parking lot also sends a changed charger placement.
    if (siteType === 'parking_lot' && placement !== chargerPlacementOf(layout)) {
      body['chargerPlacement'] = placement;
    }
    updateMutation.mutate(body);
  }

  return (
    <TabsContent value="details">
      <TabPanel
        title={t('common.details')}
        actions={
          <div className="flex flex-wrap gap-2 *:grow sm:*:grow-0">
            {canWrite && !editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            {canWrite && (
              <RemoveButton
                label={t('common.delete')}
                onClick={() => {
                  setDeleteOpen(true);
                }}
                disabled={deleteIsPending || site.stationCount > 0}
                title={site.stationCount > 0 ? t('sites.removeStationsFirst') : ''}
              />
            )}
          </div>
        }
      >
        {editing ? (
          <form onSubmit={handleSave} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name" className="leading-6">
                {t('common.name')}
              </Label>
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
              <Label htmlFor="edit-address" className="leading-6">
                {t('sites.address')}
              </Label>
              <Input
                id="edit-address"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value);
                }}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="space-y-2">
                <Label htmlFor="edit-city" className="leading-6">
                  {t('sites.city')}
                </Label>
                <Input
                  id="edit-city"
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-state" className="leading-6">
                  {t('sites.state')}
                </Label>
                <Input
                  id="edit-state"
                  value={state}
                  onChange={(e) => {
                    setState(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="space-y-2">
                <Label htmlFor="edit-postal" className="leading-6">
                  {t('sites.postalCode')}
                </Label>
                <Input
                  id="edit-postal"
                  value={postalCode}
                  onChange={(e) => {
                    setPostalCode(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-country" className="leading-6">
                  {t('sites.country')}
                </Label>
                <Input
                  id="edit-country"
                  value={country}
                  onChange={(e) => {
                    setCountry(e.target.value);
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="space-y-2">
                <Label htmlFor="edit-latitude" className="leading-6">
                  {t('sites.latitude')}
                </Label>
                <DecimalInput
                  id="edit-latitude"
                  placeholder="e.g. 40.7128"
                  value={latitude}
                  onChange={setLatitude}
                  allowNegative
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-longitude" className="leading-6">
                  {t('sites.longitude')}
                </Label>
                <DecimalInput
                  id="edit-longitude"
                  placeholder="e.g. -74.0060"
                  value={longitude}
                  onChange={setLongitude}
                  allowNegative
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
              <Label htmlFor="edit-timezone" className="leading-6">
                {t('sites.timezone')}
              </Label>
              <Select
                id="edit-timezone"
                value={editTimezone}
                onChange={(e) => {
                  setEditTimezone(e.target.value);
                }}
              >
                {TIMEZONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} ({opt.value})
                  </option>
                ))}
              </Select>
            </div>
            <HoursOfOperationField
              id="edit-hours"
              value={hoursOfOperation}
              onChange={setHoursOfOperation}
            />
            <SiteTypeField
              id="edit-site-type"
              value={siteType}
              onChange={setSiteType}
              placement={placement}
              onPlacementChange={setPlacement}
            />
            <div className="border-t pt-4 space-y-4">
              <div>
                <p className="text-sm font-medium">{t('sites.contact')}</p>
                <p className="text-xs text-muted-foreground">{t('sites.contactPublicNote')}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-contact-name" className="leading-6">
                  {t('sites.contactName')}
                </Label>
                <Input
                  id="edit-contact-name"
                  value={contactName}
                  onChange={(e) => {
                    setContactName(e.target.value);
                  }}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                <div className="space-y-2">
                  <Label htmlFor="edit-contact-email" className="leading-6">
                    {t('sites.contactEmail')}
                  </Label>
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
                  <Label htmlFor="edit-contact-phone" className="leading-6">
                    {t('sites.contactPhone')}
                  </Label>
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
            {updateMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(updateMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  setEditing(false);
                  setHasSubmitted(false);
                }}
              />
              <SaveButton isPending={updateMutation.isPending} />
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
              <dd className="font-medium whitespace-pre-line">{site.hoursOfOperation ?? 'n/a'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('sites.layoutSettings.siteType')}</dt>
              <dd className="font-medium" data-testid="site-type-value">
                {t(SITE_TYPE_LABEL[siteTypeOf(layout)])}
              </dd>
            </div>
            {siteTypeOf(layout) === 'parking_lot' && (
              <div>
                <dt className="text-muted-foreground">
                  {t('sites.layoutSettings.chargerPlacement')}
                </dt>
                <dd className="font-medium" data-testid="charger-placement-value">
                  {t(CHARGER_PLACEMENT_LABEL[chargerPlacementOf(layout)])}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">{t('sites.layout')}</dt>
              <dd className="font-medium">
                <Link
                  to={`/sites/${siteId}?tab=layout`}
                  className="text-link underline-offset-4 hover:underline"
                  data-testid="site-layout-summary"
                >
                  {layoutSummary(t, layout)}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.created')}</dt>
              <dd className="font-medium">{formatDateTime(site.createdAt, site.timezone)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
              <dd className="font-medium">{formatDateTime(site.updatedAt, site.timezone)}</dd>
            </div>
            <SiteAiInsightsRow siteId={site.id} site={site} timezone={site.timezone} />
          </dl>
        )}
      </TabPanel>
      {!editing && (
        <TabPanel title={t('sites.contact')} description={t('sites.contactPublicNote')}>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('sites.contactName')}</dt>
              <dd className="font-medium">{site.contactName ?? 'n/a'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('sites.contactEmail')}</dt>
              <dd className="font-medium">{site.contactEmail ?? 'n/a'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('sites.contactPhone')}</dt>
              <dd className="font-medium">{site.contactPhone ?? 'n/a'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('sites.contactIsPublic')}</dt>
              <dd className="font-medium">
                {site.contactIsPublic ? t('common.yes') : t('common.no')}
              </dd>
            </div>
          </dl>
        </TabPanel>
      )}
      {!editing && (
        <TabPanel
          title={t('sites.stationMessageLanguage')}
          description={t('sites.stationMessageLanguageDescription')}
        >
          <Select
            aria-label={t('sites.stationMessageLanguage')}
            value={site.stationMessageLanguage ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              stationMessageLanguageMutation.mutate(val === '' ? null : val);
            }}
            disabled={!canWrite || stationMessageLanguageMutation.isPending}
            className="max-w-sm"
          >
            <option value="">{t('sites.stationMessageLanguageDefault')}</option>
            {LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </Select>
          {stationMessageLanguageMutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              {getErrorMessage(stationMessageLanguageMutation.error, t)}
            </p>
          )}
        </TabPanel>
      )}
      {googleMapsApiKey !== '' && site.latitude != null && site.longitude != null && (
        <TabPanel title={t('sites.map')}>
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
        </TabPanel>
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('sites.deleteSiteTitle')}
        description={t('sites.deleteSiteDescription', { name: site.name })}
        confirmLabel={t('common.delete')}
        isPending={deleteIsPending}
        onConfirm={() => {
          onDelete();
          return false;
        }}
      >
        {deleteError != null && (
          <p className="text-sm text-destructive">{getErrorMessage(deleteError, t)}</p>
        )}
      </ConfirmDialog>
    </TabsContent>
  );
}
