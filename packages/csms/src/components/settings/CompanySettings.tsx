// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  DEFAULT_CURRENCY,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  type SupportedCurrency,
} from '@evtivity/lib/currency';
import {
  DEFAULT_PRICE_DISPLAY,
  DEFAULT_TAX_BASIS,
  isPriceDisplay,
  isTaxBasis,
  resolveTaxBasis,
  type PriceDisplay,
  type TaxBasis,
} from '@evtivity/lib/price-display';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { useLoadedValues } from '@/hooks/use-loaded-values';
import { ChargerPlateColorFields, chargerPlateColorErrors } from './ChargerPlateColorFields';

const CURRENCY_NAMES: Record<SupportedCurrency, string> = {
  USD: 'US Dollar',
  EUR: 'Euro',
  GBP: 'British Pound',
  CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar',
  CHF: 'Swiss Franc',
  CNY: 'Chinese Yuan',
  INR: 'Indian Rupee',
  BRL: 'Brazilian Real',
  MXN: 'Mexican Peso',
  SEK: 'Swedish Krona',
  NOK: 'Norwegian Krone',
  DKK: 'Danish Krone',
  NZD: 'New Zealand Dollar',
  SGD: 'Singapore Dollar',
  HKD: 'Hong Kong Dollar',
  ZAR: 'South African Rand',
  ILS: 'Israeli Shekel',
  AED: 'UAE Dirham',
  SAR: 'Saudi Riyal',
  TWD: 'Taiwan Dollar',
  THB: 'Thai Baht',
  PLN: 'Polish Zloty',
  CZK: 'Czech Koruna',
  HUF: 'Hungarian Forint',
  TRY: 'Turkish Lira',
  COP: 'Colombian Peso',
  ARS: 'Argentine Peso',
  PHP: 'Philippine Peso',
  MYR: 'Malaysian Ringgit',
  IDR: 'Indonesian Rupiah',
};

interface CompanyValues {
  name: string;
  currency: string;
  priceDisplay: PriceDisplay;
  taxBasis: TaxBasis;
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
  chargerColorAc: string;
  chargerColorDc: string;
  metaDescription: string;
  metaKeywords: string;
}

/** The company form values as stored (defaults while the settings load). */
function companyValuesFrom(settings: Record<string, unknown> | undefined): CompanyValues {
  const s = (key: string): string => {
    const v = settings?.[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  const priceDisplay = s('company.priceDisplay');
  return {
    name: s('company.name') || 'EVtivity',
    currency: s('company.currency').trim().toUpperCase() || DEFAULT_CURRENCY,
    priceDisplay: isPriceDisplay(priceDisplay) ? priceDisplay : DEFAULT_PRICE_DISPLAY,
    taxBasis: settings == null ? DEFAULT_TAX_BASIS : resolveTaxBasis(settings['company.taxBasis']),
    contactEmail: s('company.contactEmail'),
    supportEmail: s('company.supportEmail'),
    supportPhone: s('company.supportPhone'),
    street: s('company.street'),
    city: s('company.city'),
    state: s('company.state'),
    zip: s('company.zip'),
    country: s('company.country'),
    portalUrl: s('company.portalUrl'),
    themeColor: s('company.themeColor') || '#2563eb',
    chargerColorAc: s('company.chargerColorAc'),
    chargerColorDc: s('company.chargerColorDc'),
    metaDescription: s('company.metaDescription'),
    metaKeywords: s('company.metaKeywords'),
  };
}

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
  const { toast } = useToast();
  // Company settings also feed the public branding query (name, logo, currency).
  const invalidateSettings = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['settings'] }),
      queryClient.invalidateQueries({ queryKey: ['branding'] }),
    ]);
  };
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const ogImageInputRef = useRef<HTMLInputElement>(null);

  const savedCurrency =
    typeof settings?.['company.currency'] === 'string'
      ? settings['company.currency'].trim().toUpperCase()
      : '';
  const savedCurrencyUnsupported = savedCurrency !== '' && !isSupportedCurrency(savedCurrency);

  const loadedCompany = useMemo(() => companyValuesFrom(settings), [settings]);
  const [companyValues, setCompanyValues, takeNextCompanyLoad] =
    useLoadedValues<CompanyValues>(loadedCompany);
  const companyField =
    <K extends keyof CompanyValues>(key: K) =>
    (value: CompanyValues[K]): void => {
      setCompanyValues((prev) => ({ ...prev, [key]: value }));
    };
  const {
    name: companyName,
    currency: companyCurrency,
    priceDisplay: companyPriceDisplay,
    taxBasis: companyTaxBasis,
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
    chargerColorAc,
    chargerColorDc,
    metaDescription,
    metaKeywords,
  } = companyValues;
  const setCompanyName = companyField('name');
  const setCompanyCurrency = companyField('currency');
  const setCompanyPriceDisplay = companyField('priceDisplay');
  const setCompanyTaxBasis = companyField('taxBasis');
  const setCompanyContactEmail = companyField('contactEmail');
  const setCompanySupportEmail = companyField('supportEmail');
  const setCompanySupportPhone = companyField('supportPhone');
  const setCompanyStreet = companyField('street');
  const setCompanyCity = companyField('city');
  const setCompanyState = companyField('state');
  const setCompanyZip = companyField('zip');
  const setCompanyCountry = companyField('country');
  const setCompanyPortalUrl = companyField('portalUrl');
  const setCompanyThemeColor = companyField('themeColor');
  const setMetaDescription = companyField('metaDescription');
  const setMetaKeywords = companyField('metaKeywords');
  const [taxBasisConfirmOpen, setTaxBasisConfirmOpen] = useState(false);
  const [plateColorsSubmitted, setPlateColorsSubmitted] = useState(false);
  const savedTaxBasis = resolveTaxBasis(settings?.['company.taxBasis']);

  const companyMutation = useMutation({
    mutationFn: (vals: CompanyValues) =>
      Promise.all([
        api.put('/v1/settings/company.name', { value: vals.name }),
        api.put('/v1/settings/company.currency', { value: vals.currency }),
        api.put('/v1/settings/company.priceDisplay', { value: vals.priceDisplay }),
        api.put('/v1/settings/company.taxBasis', { value: vals.taxBasis }),
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
        api.put('/v1/settings/company.chargerColorAc', { value: vals.chargerColorAc.trim() }),
        api.put('/v1/settings/company.chargerColorDc', { value: vals.chargerColorDc.trim() }),
        api.put('/v1/settings/company.metaDescription', { value: vals.metaDescription }),
        api.put('/v1/settings/company.metaKeywords', { value: vals.metaKeywords }),
      ]),
    onSuccess: () => {
      void invalidateSettings();
    },
  });

  const saveCompany = (): void => {
    const sent = companyValues;
    companyMutation.mutate(sent, {
      onSuccess: () => {
        takeNextCompanyLoad(sent);
      },
    });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.logo', { value: dataUri }),
    onSuccess: () => {
      void invalidateSettings();
    },
  });

  const faviconUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.favicon', { value: dataUri }),
    onSuccess: () => {
      void invalidateSettings();
    },
  });

  const ogImageUploadMutation = useMutation({
    mutationFn: (dataUri: string) => api.put('/v1/settings/company.ogImage', { value: dataUri }),
    onSuccess: () => {
      void invalidateSettings();
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (svg: string) => api.put('/v1/settings/qr_code_icon', { value: svg }),
    onSuccess: () => {
      void invalidateSettings();
    },
  });

  function readImageAsDataUri(
    e: React.ChangeEvent<HTMLInputElement>,
    inputRef: React.RefObject<HTMLInputElement | null>,
    onResult: (dataUri: string) => void,
  ): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: t('settings.invalidImage'), variant: 'destructive' });
      return;
    }
    if (file.size > 512 * 1024) {
      toast({ title: t('settings.logoTooLarge'), variant: 'destructive' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      onResult(reader.result as string);
    };
    reader.readAsDataURL(file);

    if (inputRef.current != null) inputRef.current.value = '';
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>): void {
    readImageAsDataUri(e, logoInputRef, (uri) => {
      logoUploadMutation.mutate(uri);
    });
  }

  function handleFaviconChange(e: React.ChangeEvent<HTMLInputElement>): void {
    readImageAsDataUri(e, faviconInputRef, (uri) => {
      faviconUploadMutation.mutate(uri);
    });
  }

  function handleOgImageChange(e: React.ChangeEvent<HTMLInputElement>): void {
    readImageAsDataUri(e, ogImageInputRef, (uri) => {
      ogImageUploadMutation.mutate(uri);
    });
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (file == null) return;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      if (!text.trimStart().startsWith('<svg')) {
        toast({ title: t('settings.invalidSvg'), variant: 'destructive' });
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
            <Label className="leading-6">{t('settings.companyLogo')}</Label>
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLogoChange}
            />
            <div className="flex items-center gap-4">
              {settings != null && typeof settings['company.logo'] === 'string' ? (
                <img
                  src={settings['company.logo']}
                  alt={t('settings.companyLogo')}
                  className="h-16 w-16 rounded border object-contain"
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noLogo')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
            <p className="text-xs text-muted-foreground">{t('settings.uploadReplacesHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="leading-6">{t('settings.qrCodeIcon')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.qrCodeIconDescription')}</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".svg"
              className="hidden"
              onChange={handleFileChange}
            />
            {hasIcon && svgDataUri != null ? (
              <div className="flex items-start gap-4">
                <div className="flex flex-col items-center gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('settings.preview')}
                  </p>
                  <img
                    src={svgDataUri}
                    alt={t('settings.qrCodeIcon')}
                    className="h-16 w-16 rounded border p-2"
                  />
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
            ) : (
              <p className="text-sm text-muted-foreground">{t('settings.noIcon')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
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
            <p className="text-xs text-muted-foreground">{t('settings.uploadReplacesHint')}</p>
          </div>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="leading-6">{t('settings.favicon')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.faviconDescription')}</p>
            <input
              ref={faviconInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFaviconChange}
            />
            <div className="flex items-center gap-4">
              {settings != null &&
              typeof settings['company.favicon'] === 'string' &&
              settings['company.favicon'] !== '' ? (
                <img
                  src={settings['company.favicon']}
                  alt={t('settings.favicon')}
                  className="h-8 w-8 rounded border object-contain"
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noFavicon')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
            <p className="text-xs text-muted-foreground">{t('settings.uploadReplacesHint')}</p>
          </div>

          <div className="space-y-2">
            <Label className="leading-6">{t('settings.ogImage')}</Label>
            <p className="text-xs text-muted-foreground">{t('settings.ogImageDescription')}</p>
            <input
              ref={ogImageInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleOgImageChange}
            />
            <div className="flex items-center gap-4">
              {settings != null &&
              typeof settings['company.ogImage'] === 'string' &&
              settings['company.ogImage'] !== '' ? (
                <img
                  src={settings['company.ogImage']}
                  alt={t('settings.ogImage')}
                  className="h-16 w-28 rounded border object-cover"
                />
              ) : (
                <p className="text-sm text-muted-foreground">{t('settings.noOgImage')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
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
            <p className="text-xs text-muted-foreground">{t('settings.uploadReplacesHint')}</p>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-semibold">{t('settings.seoSettings')}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="meta-description" className="leading-6">
                {t('settings.metaDescription')}
              </Label>
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
              <Label htmlFor="meta-keywords" className="leading-6">
                {t('settings.metaKeywords')}
              </Label>
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
          <Label className="leading-6">{t('settings.themeColor')}</Label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              aria-label={t('settings.themeColorPicker')}
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
              placeholder="#2563eb"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.themeColorDescription')}</p>
        </div>

        <ChargerPlateColorFields
          chargerColorAc={chargerColorAc}
          chargerColorDc={chargerColorDc}
          themeColor={companyThemeColor}
          showErrors={plateColorsSubmitted}
          onChange={(key, value) => {
            companyField(key)(value);
          }}
        />

        <ConfirmDialog
          open={taxBasisConfirmOpen}
          onOpenChange={setTaxBasisConfirmOpen}
          title={t('settings.companyTaxBasisConfirmTitle')}
          description={t('settings.companyTaxBasisConfirmDescription', {
            basis:
              companyTaxBasis === 'gross'
                ? t('settings.companyTaxBasisGross')
                : t('settings.companyTaxBasisNet'),
          })}
          confirmLabel={t('settings.companyTaxBasisConfirm')}
          variant="default"
          isPending={companyMutation.isPending}
          onConfirm={() => {
            setTaxBasisConfirmOpen(false);
            saveCompany();
          }}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPlateColorsSubmitted(true);
            if (Object.keys(chargerPlateColorErrors(companyValues)).length > 0) return;
            // A different tax basis reinterprets every stored tariff price:
            // confirm before saving it.
            if (companyTaxBasis !== savedTaxBasis) {
              setTaxBasisConfirmOpen(true);
              return;
            }
            saveCompany();
          }}
          noValidate
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company-name" className="leading-6">
                {t('settings.companyName')}
              </Label>
              <Input
                id="company-name"
                value={companyName}
                onChange={(e) => {
                  setCompanyName(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-currency" className="leading-6">
                {t('settings.companyCurrency')}
              </Label>
              <Select
                id="company-currency"
                value={companyCurrency}
                onChange={(e) => {
                  setCompanyCurrency(e.target.value);
                }}
              >
                {!isSupportedCurrency(companyCurrency) && (
                  <option value={companyCurrency} disabled>
                    {companyCurrency}
                  </option>
                )}
                {SUPPORTED_CURRENCIES.map((code) => (
                  <option key={code} value={code}>
                    {`${code} - ${CURRENCY_NAMES[code]}`}
                  </option>
                ))}
              </Select>
              {savedCurrencyUnsupported && (
                <p className="text-sm text-destructive">
                  {t('settings.companyCurrencyUnsupported', { currency: savedCurrency })}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-price-display" className="leading-6">
                {t('settings.companyPriceDisplay')}
              </Label>
              <Select
                id="company-price-display"
                value={companyPriceDisplay}
                onChange={(e) => {
                  if (isPriceDisplay(e.target.value)) setCompanyPriceDisplay(e.target.value);
                }}
              >
                <option value="gross">{t('settings.companyPriceDisplayGross')}</option>
                <option value="net">{t('settings.companyPriceDisplayNet')}</option>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('settings.companyPriceDisplayHelper')}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-tax-basis" className="leading-6">
                {t('settings.companyTaxBasis')}
              </Label>
              <Select
                id="company-tax-basis"
                value={companyTaxBasis}
                onChange={(e) => {
                  if (isTaxBasis(e.target.value)) setCompanyTaxBasis(e.target.value);
                }}
              >
                <option value="net">{t('settings.companyTaxBasisNet')}</option>
                <option value="gross">{t('settings.companyTaxBasisGross')}</option>
              </Select>
              <p className="text-xs text-muted-foreground">{t('settings.companyTaxBasisHelper')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-contact-email" className="leading-6">
                {t('settings.companyContactEmail')}
              </Label>
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
              <Label htmlFor="company-support-email" className="leading-6">
                {t('settings.companySupportEmail')}
              </Label>
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
              <Label htmlFor="company-support-phone" className="leading-6">
                {t('settings.companySupportPhone')}
              </Label>
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
              <Label htmlFor="company-street" className="leading-6">
                {t('settings.companyStreet')}
              </Label>
              <Input
                id="company-street"
                value={companyStreet}
                onChange={(e) => {
                  setCompanyStreet(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-city" className="leading-6">
                {t('settings.companyCity')}
              </Label>
              <Input
                id="company-city"
                value={companyCity}
                onChange={(e) => {
                  setCompanyCity(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-state" className="leading-6">
                {t('settings.companyState')}
              </Label>
              <Input
                id="company-state"
                value={companyState}
                onChange={(e) => {
                  setCompanyState(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-zip" className="leading-6">
                {t('settings.companyZip')}
              </Label>
              <Input
                id="company-zip"
                value={companyZip}
                onChange={(e) => {
                  setCompanyZip(e.target.value);
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company-country" className="leading-6">
                {t('settings.companyCountry')}
              </Label>
              <Input
                id="company-country"
                value={companyCountry}
                onChange={(e) => {
                  setCompanyCountry(e.target.value);
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="company-portal-url" className="leading-6">
              {t('settings.companyPortalUrl')}
            </Label>
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
            <p className="text-sm text-success">{t('settings.companySaved')}</p>
          )}
          {companyMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(companyMutation.error, t, 'settings.companySaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
