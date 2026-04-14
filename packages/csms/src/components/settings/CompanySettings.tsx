// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';

interface CompanySettingsProps {
  settings: Record<string, unknown> | undefined;
  svgDataUri: string | null;
  hasIcon: boolean;
}

export function CompanySettings({
  settings,
  svgDataUri,
  hasIcon,
}: CompanySettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const ogImageInputRef = useRef<HTMLInputElement>(null);

  const [companyName, setCompanyName] = useState('EVtivity');
  const [companyCurrency, setCompanyCurrency] = useState('USD');
  const [companyContactEmail, setCompanyContactEmail] = useState('');
  const [companySupportEmail, setCompanySupportEmail] = useState('');
  const [companySupportPhone, setCompanySupportPhone] = useState('');
  const [companyStreet, setCompanyStreet] = useState('');
  const [companyCity, setCompanyCity] = useState('');
  const [companyState, setCompanyState] = useState('');
  const [companyZip, setCompanyZip] = useState('');
  const [companyCountry, setCompanyCountry] = useState('');
  const [companyPortalUrl, setCompanyPortalUrl] = useState('');
  const [companyThemeColor, setCompanyThemeColor] = useState('#2563eb');
  const [metaDescription, setMetaDescription] = useState('');
  const [metaKeywords, setMetaKeywords] = useState('');

  useEffect(() => {
    if (settings == null) return;
    const s = (key: string): string => {
      const v = settings[key];
      return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    };
    setCompanyName(s('company.name') || 'EVtivity');
    setCompanyCurrency(s('company.currency') || 'USD');
    setCompanyContactEmail(s('company.contactEmail'));
    setCompanySupportEmail(s('company.supportEmail'));
    setCompanySupportPhone(s('company.supportPhone'));
    setCompanyStreet(s('company.street'));
    setCompanyCity(s('company.city'));
    setCompanyState(s('company.state'));
    setCompanyZip(s('company.zip'));
    setCompanyCountry(s('company.country'));
    setCompanyPortalUrl(s('company.portalUrl'));
    setCompanyThemeColor(s('company.themeColor') || '#2563eb');
    setMetaDescription(s('company.metaDescription'));
    setMetaKeywords(s('company.metaKeywords'));
  }, [settings]);

  const companyMutation = useMutation({
    mutationFn: (vals: {
      name: string;
      currency: string;
      contactEmail: string;
      supportEmail: string;
      supportPhone: string;
      street: string;
      city: string;
      state: string;
      zip: string;
      country: string;
      portalUrl: string;
      themeColor: string;
      metaDescription: string;
      metaKeywords: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/company.name', { value: vals.name }),
        api.put('/v1/settings/company.currency', { value: vals.currency }),
        api.put('/v1/settings/company.contactEmail', { value: vals.contactEmail }),
        api.put('/v1/settings/company.supportEmail', { value: vals.supportEmail }),
        api.put('/v1/settings/company.supportPhone', { value: vals.supportPhone }),
        api.put('/v1/settings/company.street', { value: vals.street }),
        api.put('/v1/settings/company.city', { value: vals.city }),
        api.put('/v1/settings/company.state', { value: vals.state }),
        api.put('/v1/settings/company.zip', { value: vals.zip }),
        api.put('/v1/settings/company.country', { value: vals.country }),
        api.put('/v1/settings/company.portalUrl', { value: vals.portalUrl }),
        api.put('/v1/settings/company.themeColor', { value: vals.themeColor }),
        api.put('/v1/settings/company.metaDescription', { value: vals.metaDescription }),
        api.put('/v1/settings/company.metaKeywords', { value: vals.metaKeywords }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const logoUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.logo', { value: dataUri }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const logoRemoveMutation = useMutation({
    mutationFn: () => api.delete('/v1/settings/company.logo'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const faviconUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.favicon', { value: dataUri }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const faviconRemoveMutation = useMutation({
    mutationFn: () => api.delete('/v1/settings/company.favicon'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const ogImageUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.ogImage', { value: dataUri }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const ogImageRemoveMutation = useMutation({
    mutationFn: () => api.delete('/v1/settings/company.ogImage'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (svg: string) => api.put('/v1/settings/qr_code_icon', { value: svg }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => api.delete('/v1/settings/qr_code_icon'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    if (!file.type.startsWith('image/')) {
      alert(t('settings.invalidImage'));
      return;
    }

    if (file.size > 512 * 1024) {
      alert(t('settings.logoTooLarge'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      logoUploadMutation.mutate(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (logoInputRef.current != null) {
      logoInputRef.current.value = '';
    }
  }

  function handleFaviconChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    if (!file.type.startsWith('image/')) {
      alert(t('settings.invalidImage'));
      return;
    }

    if (file.size > 512 * 1024) {
      alert(t('settings.logoTooLarge'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      faviconUploadMutation.mutate(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (faviconInputRef.current != null) {
      faviconInputRef.current.value = '';
    }
  }

  function handleOgImageChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    if (!file.type.startsWith('image/')) {
      alert(t('settings.invalidImage'));
      return;
    }

    if (file.size > 512 * 1024) {
      alert(t('settings.logoTooLarge'));
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      ogImageUploadMutation.mutate(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (ogImageInputRef.current != null) {
      ogImageInputRef.current.value = '';
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (!text.trimStart().startsWith('<svg')) {
        alert(t('settings.invalidSvg'));
        return;
      }
      uploadMutation.mutate(text);
    };
    reader.readAsText(file);

    if (fileInputRef.current != null) {
      fileInputRef.current.value = '';
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.companyInfo')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.companyInfoDescription')}</p>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('settings.companyLogo')}</Label>
            <div className="flex items-center gap-4">
              {settings != null && typeof settings['company.logo'] === 'string' ? (
                <>
                  <img
                    src={settings['company.logo']}
                    alt="Company logo"
                    className="h-16 w-16 rounded border object-contain"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      logoRemoveMutation.mutate();
                    }}
                    disabled={logoRemoveMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('settings.removeLogo')}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noLogo')}</p>
              )}
            </div>
            <div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleLogoChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  logoInputRef.current?.click();
                }}
                disabled={logoUploadMutation.isPending}
              >
                <Upload className="h-4 w-4" />
                {t('settings.uploadLogo')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.qrCodeIcon')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.qrCodeIconDescription')}</p>
            {hasIcon && svgDataUri != null ? (
              <div className="space-y-3">
                <div className="flex items-start gap-4">
                  <div className="flex flex-col items-center gap-1">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t('settings.preview')}
                    </p>
                    <img src={svgDataUri} alt="QR icon" className="h-16 w-16 rounded border p-2" />
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <p className="text-xs font-medium text-muted-foreground">QR</p>
                    <QRCodeSVG
                      value="https://portal.evtivity.com/charge/DEMO/1"
                      size={120}
                      level="H"
                      marginSize={4}
                      imageSettings={{
                        src: svgDataUri,
                        height: 24,
                        width: 24,
                        excavate: true,
                      }}
                    />
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    removeMutation.mutate();
                  }}
                  disabled={removeMutation.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                  {t('settings.removeIcon')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('settings.noIcon')}</p>
            )}
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg"
                className="hidden"
                onChange={handleFileChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  fileInputRef.current?.click();
                }}
                disabled={uploadMutation.isPending}
              >
                <Upload className="h-4 w-4" />
                {t('settings.uploadSvg')}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('settings.favicon')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.faviconDescription')}</p>
            <div className="flex items-center gap-4">
              {settings != null &&
              typeof settings['company.favicon'] === 'string' &&
              settings['company.favicon'] !== '' ? (
                <>
                  <img
                    src={settings['company.favicon']}
                    alt="Favicon"
                    className="h-8 w-8 rounded border object-contain"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      faviconRemoveMutation.mutate();
                    }}
                    disabled={faviconRemoveMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('settings.removeFavicon')}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noFavicon')}</p>
              )}
            </div>
            <div>
              <input
                ref={faviconInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFaviconChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  faviconInputRef.current?.click();
                }}
                disabled={faviconUploadMutation.isPending}
              >
                <Upload className="h-4 w-4" />
                {t('settings.uploadFavicon')}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('settings.ogImage')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.ogImageDescription')}</p>
            <div className="flex items-center gap-4">
              {settings != null &&
              typeof settings['company.ogImage'] === 'string' &&
              settings['company.ogImage'] !== '' ? (
                <>
                  <img
                    src={settings['company.ogImage']}
                    alt="OG image"
                    className="h-16 w-28 rounded border object-cover"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      ogImageRemoveMutation.mutate();
                    }}
                    disabled={ogImageRemoveMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t('settings.removeOgImage')}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noOgImage')}</p>
              )}
            </div>
            <div>
              <input
                ref={ogImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleOgImageChange}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  ogImageInputRef.current?.click();
                }}
                disabled={ogImageUploadMutation.isPending}
              >
                <Upload className="h-4 w-4" />
                {t('settings.uploadOgImage')}
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{t('settings.seoSettings')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-description">{t('settings.metaDescription')}</Label>
              <Input
                id="meta-description"
                value={metaDescription}
                onChange={(e) => {
                  setMetaDescription(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('settings.metaDescriptionHelper')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="meta-keywords">{t('settings.metaKeywords')}</Label>
              <Input
                id="meta-keywords"
                value={metaKeywords}
                onChange={(e) => {
                  setMetaKeywords(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('settings.metaKeywordsHelper')}</p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Label>{t('settings.themeColor')}</Label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              aria-label="Theme color picker"
              value={companyThemeColor}
              onChange={(e) => {
                setCompanyThemeColor(e.target.value);
              }}
              className="h-9 w-9 cursor-pointer rounded-md border p-0.5"
            />
            <Input
              id="company-theme-color"
              value={companyThemeColor}
              onChange={(e) => {
                setCompanyThemeColor(e.target.value);
              }}
              className="w-32"
              maxLength={7}
              placeholder="#2563eb"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.themeColorDescription')}</p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            companyMutation.mutate({
              name: companyName,
              currency: companyCurrency,
              contactEmail: companyContactEmail,
              supportEmail: companySupportEmail,
              supportPhone: companySupportPhone,
              street: companyStreet,
              city: companyCity,
              state: companyState,
              zip: companyZip,
              country: companyCountry,
              portalUrl: companyPortalUrl,
              themeColor: companyThemeColor,
              metaDescription,
              metaKeywords,
            });
          }}
          noValidate
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company-name">{t('settings.companyName')}</Label>
              <Input
                id="company-name"
                value={companyName}
                onChange={(e) => {
                  setCompanyName(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-currency">{t('settings.companyCurrency')}</Label>
              <Select
                id="company-currency"
                value={companyCurrency}
                onChange={(e) => {
                  setCompanyCurrency(e.target.value);
                }}
                className="h-9"
              >
                <option value="USD">USD - US Dollar</option>
                <option value="EUR">EUR - Euro</option>
                <option value="GBP">GBP - British Pound</option>
                <option value="CAD">CAD - Canadian Dollar</option>
                <option value="AUD">AUD - Australian Dollar</option>
                <option value="CHF">CHF - Swiss Franc</option>
                <option value="JPY">JPY - Japanese Yen</option>
                <option value="CNY">CNY - Chinese Yuan</option>
                <option value="KRW">KRW - South Korean Won</option>
                <option value="INR">INR - Indian Rupee</option>
                <option value="BRL">BRL - Brazilian Real</option>
                <option value="MXN">MXN - Mexican Peso</option>
                <option value="SEK">SEK - Swedish Krona</option>
                <option value="NOK">NOK - Norwegian Krone</option>
                <option value="DKK">DKK - Danish Krone</option>
                <option value="NZD">NZD - New Zealand Dollar</option>
                <option value="SGD">SGD - Singapore Dollar</option>
                <option value="HKD">HKD - Hong Kong Dollar</option>
                <option value="ZAR">ZAR - South African Rand</option>
                <option value="ILS">ILS - Israeli Shekel</option>
                <option value="AED">AED - UAE Dirham</option>
                <option value="SAR">SAR - Saudi Riyal</option>
                <option value="TWD">TWD - Taiwan Dollar</option>
                <option value="THB">THB - Thai Baht</option>
                <option value="PLN">PLN - Polish Zloty</option>
                <option value="CZK">CZK - Czech Koruna</option>
                <option value="HUF">HUF - Hungarian Forint</option>
                <option value="TRY">TRY - Turkish Lira</option>
                <option value="CLP">CLP - Chilean Peso</option>
                <option value="COP">COP - Colombian Peso</option>
                <option value="ARS">ARS - Argentine Peso</option>
                <option value="PHP">PHP - Philippine Peso</option>
                <option value="MYR">MYR - Malaysian Ringgit</option>
                <option value="IDR">IDR - Indonesian Rupiah</option>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-contact-email">{t('settings.companyContactEmail')}</Label>
              <Input
                id="company-contact-email"
                type="email"
                value={companyContactEmail}
                onChange={(e) => {
                  setCompanyContactEmail(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-support-email">{t('settings.companySupportEmail')}</Label>
              <Input
                id="company-support-email"
                type="email"
                value={companySupportEmail}
                onChange={(e) => {
                  setCompanySupportEmail(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-support-phone">{t('settings.companySupportPhone')}</Label>
              <Input
                id="company-support-phone"
                type="tel"
                value={companySupportPhone}
                onChange={(e) => {
                  setCompanySupportPhone(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-street">{t('settings.companyStreet')}</Label>
              <Input
                id="company-street"
                value={companyStreet}
                onChange={(e) => {
                  setCompanyStreet(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-city">{t('settings.companyCity')}</Label>
              <Input
                id="company-city"
                value={companyCity}
                onChange={(e) => {
                  setCompanyCity(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-state">{t('settings.companyState')}</Label>
              <Input
                id="company-state"
                value={companyState}
                onChange={(e) => {
                  setCompanyState(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-zip">{t('settings.companyZip')}</Label>
              <Input
                id="company-zip"
                value={companyZip}
                onChange={(e) => {
                  setCompanyZip(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-country">{t('settings.companyCountry')}</Label>
              <Input
                id="company-country"
                value={companyCountry}
                onChange={(e) => {
                  setCompanyCountry(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="company-portal-url">{t('settings.companyPortalUrl')}</Label>
            <Input
              id="company-portal-url"
              type="url"
              placeholder="https://portal.example.com"
              value={companyPortalUrl}
              onChange={(e) => {
                setCompanyPortalUrl(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">{t('settings.companyPortalUrlHint')}</p>
          </div>

          <SaveButton isPending={companyMutation.isPending} />
          {companyMutation.isSuccess && (
            <p className="text-sm text-green-600">{t('settings.companySaved')}</p>
          )}
          {companyMutation.isError && (
            <p className="text-sm text-destructive">{t('settings.companySaveFailed')}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
