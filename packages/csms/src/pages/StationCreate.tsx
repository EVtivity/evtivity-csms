// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { GoogleMapPicker } from '@/components/GoogleMapPicker';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface Station {
  id: string;
  stationId: string;
}

interface Site {
  id: string;
  name: string;
}

export function StationCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [stationId, setStationId] = useState('');
  const [model, setModel] = useState('');
  const [siteId, setSiteId] = useState('');
  const [securityProfile, setSecurityProfile] = useState('1');
  const [password, setPassword] = useState('');
  const [isSimulator, setIsSimulator] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<{ data: Site[]; total: number }>('/v1/sites?limit=100'),
  });

  const siteList = sites?.data;

  const createMutation = useMutation({
    mutationFn: (body: {
      stationId: string;
      model?: string;
      siteId?: string;
      securityProfile?: number;
      password?: string;
      isSimulator?: boolean;
    }) => api.post<Station>('/v1/stations', body),
    onSuccess: (created) => {
      void navigate(`/stations/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!stationId.trim()) errors.stationId = t('validation.required');
    if (securityProfile !== '0' && !password.trim()) errors.password = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    createMutation.mutate({
      stationId,
      ...(model.trim() !== '' ? { model } : {}),
      ...(siteId !== '' ? { siteId } : {}),
      securityProfile: Number(securityProfile),
      ...(password.trim() !== '' ? { password } : {}),
      isSimulator,
      ...(latitude.trim() !== '' ? { latitude } : {}),
      ...(longitude.trim() !== '' ? { longitude } : {}),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/stations" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('stations.createStation')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="stationId">{t('stations.stationId')}</Label>
              <Input
                id="stationId"
                value={stationId}
                onChange={(e) => {
                  setStationId(e.target.value);
                }}
                className={hasSubmitted && errors.stationId ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.stationId && (
                <p className="text-sm text-destructive">{errors.stationId}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">{t('stations.model')}</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="siteId">{t('stations.site')}</Label>
              <Select
                id="siteId"
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                }}
                className="h-9"
              >
                <option value="">{t('common.noSite')}</option>
                {siteList?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="securityProfile">{t('stations.securityProfile')}</Label>
              <Select
                id="securityProfile"
                value={securityProfile}
                onChange={(e) => {
                  setSecurityProfile(e.target.value);
                }}
                className="h-9"
              >
                <option value="0">{t('stations.sp0')}</option>
                <option value="1">{t('stations.sp1')}</option>
                <option value="2">{t('stations.sp2')}</option>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="isSimulator"
                checked={isSimulator}
                onChange={(e) => {
                  setIsSimulator(e.target.checked);
                }}
              />
              <Label htmlFor="isSimulator">{t('stations.isSimulator')}</Label>
              <p className="text-xs text-muted-foreground">{t('stations.isSimulatorHelp')}</p>
            </div>
            {securityProfile !== '0' && (
              <div className="space-y-2">
                <Label htmlFor="password">{t('stations.password')}</Label>
                <PasswordInput
                  id="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                  placeholder={t('stations.passwordPlaceholder')}
                  className={hasSubmitted && errors.password ? 'border-destructive' : ''}
                />
                {hasSubmitted && errors.password && (
                  <p className="text-sm text-destructive">{errors.password}</p>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="latitude">{t('stations.latitude')}</Label>
                <Input
                  id="latitude"
                  value={latitude}
                  onChange={(e) => {
                    setLatitude(e.target.value);
                  }}
                  placeholder="43.338131"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="longitude">{t('stations.longitude')}</Label>
                <Input
                  id="longitude"
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
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/stations');
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
