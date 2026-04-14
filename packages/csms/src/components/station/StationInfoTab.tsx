// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { EditButton } from '@/components/edit-button';
import { RemoveButton } from '@/components/remove-button';
import { CopyableId } from '@/components/copyable-id';
import { CancelButton } from '@/components/cancel-button';
import { SaveButton } from '@/components/save-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { FileViewerDialog } from '@/components/FileViewerDialog';
import { api } from '@/lib/api';
import { OCPP_BASE_URL } from '@/lib/config';
import { formatDateTime } from '@/lib/timezone';

interface Site {
  id: string;
  name: string;
  timezone: string;
}

interface Station {
  id: string;
  stationId: string;
  siteId: string | null;
  vendorName: string | null;
  model: string | null;
  serialNumber: string | null;
  firmwareVersion: string | null;
  iccid: string | null;
  imsi: string | null;
  availability: string;
  onboardingStatus: string;
  status: string;
  isOnline: boolean;
  isSimulator: boolean;
  lastHeartbeat: string | null;
  ocppProtocol: string | null;
  securityProfile: number;
  hasPassword: boolean;
  latitude: string | null;
  longitude: string | null;
  reservationsEnabled: boolean;
  siteHoursOfOperation: string | null;
  siteFreeVendEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StationImage {
  id: number;
  stationId: string;
  fileName: string;
  fileSize: number;
  contentType: string;
  s3Key: string;
  s3Bucket: string;
  caption: string | null;
  tags: string[];
  isDriverVisible: boolean;
  isMainImage: boolean;
  sortOrder: number;
  uploadedBy: string | null;
  createdAt: string;
}

export interface StationInfoTabProps {
  station: Station;
  stationId: string;
  siteTimezone: string;
}

export function StationInfoTab({
  station,
  stationId,
  siteTimezone,
}: StationInfoTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [model, setModel] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [siteId, setSiteId] = useState('');
  const [isSimulator, setIsSimulator] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [mainImageUrl, setMainImageUrl] = useState<string | null>(null);
  const [headerViewerOpen, setHeaderViewerOpen] = useState(false);

  const { data: sitesResponse } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });
  const sites = sitesResponse?.data;

  const { data: stationImages } = useQuery({
    queryKey: ['stations', stationId, 'images'],
    queryFn: () => api.get<StationImage[]>(`/v1/stations/${stationId}/images`),
  });

  const mainImage = stationImages?.find((img) => img.isMainImage);

  useEffect(() => {
    if (mainImage == null) {
      setMainImageUrl(null);
      return;
    }
    api
      .get<{ downloadUrl: string }>(
        `/v1/stations/${stationId}/images/${String(mainImage.id)}/download-url`,
      )
      .then((res) => {
        setMainImageUrl(res.downloadUrl);
      })
      .catch(() => {
        setMainImageUrl(null);
      });
  }, [mainImage, stationId]);

  const updateMutation = useMutation({
    mutationFn: (body: {
      model?: string;
      serialNumber?: string;
      siteId?: string | null;
      isSimulator?: boolean;
      latitude?: string;
      longitude?: string;
    }) => api.patch<Station>(`/v1/stations/${stationId}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations', stationId] });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete<Station>(`/v1/stations/${stationId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['stations'] });
      void navigate('/stations');
    },
  });

  function startEdit(): void {
    setModel(station.model ?? '');
    setSerialNumber(station.serialNumber ?? '');
    setSiteId(station.siteId ?? '');
    setIsSimulator(station.isSimulator);
    setLatitude(station.latitude ?? '');
    setLongitude(station.longitude ?? '');
    setEditing(true);
  }

  function handleSave(e: React.SyntheticEvent): void {
    e.preventDefault();
    updateMutation.mutate({
      ...(model !== '' ? { model } : {}),
      ...(serialNumber !== '' ? { serialNumber } : {}),
      siteId: siteId !== '' ? siteId : null,
      isSimulator,
      ...(latitude.trim() !== '' ? { latitude } : {}),
      ...(longitude.trim() !== '' ? { longitude } : {}),
    });
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('common.details')}</CardTitle>
          <div className="flex gap-2">
            {!editing && <EditButton label={t('common.edit')} onClick={startEdit} />}
            <RemoveButton
              label={t('common.remove')}
              onClick={() => {
                deleteMutation.mutate();
              }}
              disabled={deleteMutation.isPending}
            />
          </div>
        </CardHeader>
        <CardContent>
          {editing ? (
            <form onSubmit={handleSave} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-model">{t('stations.model')}</Label>
                <Input
                  id="edit-model"
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-serial">{t('stations.serialNumber')}</Label>
                <Input
                  id="edit-serial"
                  value={serialNumber}
                  onChange={(e) => {
                    setSerialNumber(e.target.value);
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-site">{t('stations.site')}</Label>
                <Select
                  id="edit-site"
                  value={siteId}
                  onChange={(e) => {
                    setSiteId(e.target.value);
                  }}
                  className="h-9"
                >
                  <option value="">{t('common.noSite')}</option>
                  {sites?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="edit-simulator"
                  checked={isSimulator}
                  onChange={(e) => {
                    setIsSimulator(e.target.checked);
                  }}
                />
                <Label htmlFor="edit-simulator">{t('stations.isSimulator')}</Label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-latitude">{t('stations.latitude')}</Label>
                  <Input
                    id="edit-latitude"
                    value={latitude}
                    onChange={(e) => {
                      setLatitude(e.target.value);
                    }}
                    placeholder="43.338131"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-longitude">{t('stations.longitude')}</Label>
                  <Input
                    id="edit-longitude"
                    value={longitude}
                    onChange={(e) => {
                      setLongitude(e.target.value);
                    }}
                    placeholder="-73.695849"
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
              <div className="flex gap-2">
                <SaveButton isPending={updateMutation.isPending} />
                <CancelButton
                  onClick={() => {
                    setEditing(false);
                  }}
                />
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              {mainImage != null && mainImageUrl != null && (
                <div className="hidden md:block md:col-start-2 md:row-span-3 md:row-start-1">
                  <img
                    src={mainImageUrl}
                    alt={station.stationId}
                    className="h-[150px] w-[200px] rounded-lg object-cover cursor-pointer"
                    onClick={() => {
                      setHeaderViewerOpen(true);
                    }}
                  />
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">{t('stations.site')}</dt>
                <dd className="font-medium">
                  {station.siteId != null ? (
                    <Link to={`/sites/${station.siteId}`} className="text-primary hover:underline">
                      {sites?.find((s) => s.id === station.siteId)?.name ?? station.siteId}
                    </Link>
                  ) : (
                    '-'
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.status')}</dt>
                <dd className="font-medium">{t(`status.${station.status}`, station.status)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.vendor')}</dt>
                <dd className="font-medium">{station.vendorName ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.model')}</dt>
                <dd className="font-medium">{station.model ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.serialNumber')}</dt>
                <dd className="font-medium">{station.serialNumber ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.firmware')}</dt>
                <dd className="font-medium">{station.firmwareVersion ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.ocppProtocol')}</dt>
                <dd className="font-medium">{station.ocppProtocol ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.simulator')}</dt>
                <dd className="font-medium">
                  {station.isSimulator ? t('common.yes') : t('common.no')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.latitude')}</dt>
                <dd className="font-medium">{station.latitude ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.longitude')}</dt>
                <dd className="font-medium">{station.longitude ?? '-'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.lastHeartbeat')}</dt>
                <dd className="font-medium">
                  {station.lastHeartbeat != null
                    ? formatDateTime(station.lastHeartbeat, siteTimezone)
                    : '-'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.created')}</dt>
                <dd className="font-medium">{formatDateTime(station.createdAt, siteTimezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('common.lastUpdated')}</dt>
                <dd className="font-medium">{formatDateTime(station.updatedAt, siteTimezone)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('stations.hoursOfOperation')}</dt>
                <dd className="font-medium whitespace-pre-line">
                  {station.siteHoursOfOperation ?? '-'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground flex items-center gap-1">
                  {t('stations.ocppUrl')}
                  <InfoTooltip
                    content={<div className="max-w-64">{t('stations.ocppUrlHelp')}</div>}
                  />
                </dt>
                <dd className="font-medium">
                  {OCPP_BASE_URL !== '' ? (
                    <CopyableId id={`${OCPP_BASE_URL}/${station.stationId}`} variant="detail" />
                  ) : (
                    <span className="text-muted-foreground">
                      {t('stations.ocppUrlNotConfigured')}
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
      {headerViewerOpen && stationImages != null && stationImages.length > 0 && (
        <FileViewerDialog
          files={stationImages}
          currentIndex={stationImages.findIndex((img) => img.isMainImage)}
          onClose={() => {
            setHeaderViewerOpen(false);
          }}
          onNavigate={() => {}}
          getDownloadUrl={async (file) => {
            const res = await api.get<{ downloadUrl: string }>(
              `/v1/stations/${stationId}/images/${String(file.id)}/download-url`,
            );
            return res.downloadUrl;
          }}
        />
      )}
    </>
  );
}
