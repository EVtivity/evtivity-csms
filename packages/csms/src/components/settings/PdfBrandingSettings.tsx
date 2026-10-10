// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import {
  MAX_PDF_FOOTER_LENGTH,
  MAX_PDF_FOOTER_LINES,
  MAX_PDF_LOGO_BYTES,
  PDF_FOOTER_KEY,
  PDF_LOGO_KEY,
  defaultPdfLogoDataUri,
  normalizePdfFooter,
} from '@evtivity/lib/pdf-branding';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FileUploadButton } from '@/components/ui/file-upload-button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasCompanyWidePermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';

const LOGO_TYPES = ['image/png', 'image/svg+xml'];
const MAX_LOGO_KB = MAX_PDF_LOGO_BYTES / 1024;

interface Props {
  settings: Record<string, unknown> | undefined;
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Could not read the file'));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * The logo and the footer printed on every PDF (invoices, credit notes, fleet
 * invoices, reports): `pdf.logo` and `pdf.footer`. An empty logo is the
 * default EVtivity logo. Users without `settings.system:write` or all-site
 * access see the values but cannot change them.
 */
export function PdfBrandingSettings({ settings }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useHasCompanyWidePermission('settings.system:write');

  const storedLogo = typeof settings?.[PDF_LOGO_KEY] === 'string' ? settings[PDF_LOGO_KEY] : '';
  const storedFooter =
    typeof settings?.[PDF_FOOTER_KEY] === 'string' ? settings[PDF_FOOTER_KEY] : '';
  const isDefaultLogo = storedLogo === '';
  const [footer, setFooter] = useState(storedFooter);

  useEffect(() => {
    setFooter(storedFooter);
  }, [storedFooter]);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  const logoMutation = useMutation({
    mutationFn: (value: string) => api.put(`/v1/settings/${PDF_LOGO_KEY}`, { value }),
    onSuccess: () => {
      void invalidate();
      toast({ title: t('settings.pdfLogoSaved'), variant: 'success' });
    },
    onError: (err: unknown) => {
      toast({
        title: getErrorMessage(err, t, 'settings.pdfBrandingSaveFailed'),
        variant: 'destructive',
      });
    },
  });

  const footerMutation = useMutation({
    mutationFn: (value: string) => api.put(`/v1/settings/${PDF_FOOTER_KEY}`, { value }),
    onSuccess: () => {
      void invalidate();
    },
  });

  async function handleLogoFiles(files: File[]): Promise<void> {
    const file = files[0];
    if (file == null) return;
    if (!LOGO_TYPES.includes(file.type)) {
      toast({ title: t('settings.pdfLogoInvalidType'), variant: 'destructive' });
      return;
    }
    if (file.size > MAX_PDF_LOGO_BYTES) {
      toast({
        title: t('settings.pdfLogoTooLarge', { maxKb: MAX_LOGO_KB }),
        variant: 'destructive',
      });
      return;
    }
    try {
      logoMutation.mutate(await readAsDataUri(file));
    } catch (err) {
      toast({
        title: getErrorMessage(err, t, 'settings.pdfBrandingSaveFailed'),
        variant: 'destructive',
      });
    }
  }

  const normalizedFooter = normalizePdfFooter(footer);
  const footerInvalid = normalizedFooter == null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.pdfBranding')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">{t('settings.pdfBrandingDescription')}</p>

        <div className="space-y-2">
          <Label className="leading-6">{t('settings.pdfLogo')}</Label>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-20 w-64 items-center justify-center rounded border bg-white p-2">
              <img
                src={isDefaultLogo ? defaultPdfLogoDataUri() : storedLogo}
                alt={t('settings.pdfLogo')}
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <div className="flex flex-col gap-2">
              {isDefaultLogo && (
                <p className="text-xs text-muted-foreground">{t('settings.pdfLogoDefault')}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <FileUploadButton
                  variant="outline"
                  size="sm"
                  accept=".png,.svg,image/png,image/svg+xml"
                  disabled={!canWrite || logoMutation.isPending}
                  onFiles={(files) => {
                    void handleLogoFiles(files);
                  }}
                >
                  {t('settings.pdfLogoUpload')}
                </FileUploadButton>
                {!isDefaultLogo && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canWrite || logoMutation.isPending}
                    onClick={() => {
                      logoMutation.mutate('');
                    }}
                  >
                    <RotateCcw className="h-4 w-4" />
                    {t('settings.pdfLogoReset')}
                  </Button>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('settings.pdfLogoHelp', { maxKb: MAX_LOGO_KB })}
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (normalizedFooter == null) return;
            footerMutation.mutate(normalizedFooter);
          }}
          noValidate
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="pdf-footer" className="leading-6">
              {t('settings.pdfFooter')}
            </Label>
            <Textarea
              id="pdf-footer"
              rows={MAX_PDF_FOOTER_LINES}
              maxLength={MAX_PDF_FOOTER_LENGTH}
              value={footer}
              disabled={!canWrite}
              aria-invalid={footerInvalid}
              onChange={(e) => {
                setFooter(e.target.value);
              }}
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {t('settings.pdfFooterHelp', {
                  maxLines: MAX_PDF_FOOTER_LINES,
                  maxLength: MAX_PDF_FOOTER_LENGTH,
                })}
              </span>
              <span>{`${String(footer.length)} / ${String(MAX_PDF_FOOTER_LENGTH)}`}</span>
            </div>
            {footerInvalid && (
              <p className="text-sm text-destructive">
                {t('settings.pdfFooterInvalid', {
                  maxLines: MAX_PDF_FOOTER_LINES,
                  maxLength: MAX_PDF_FOOTER_LENGTH,
                })}
              </p>
            )}
          </div>

          {canWrite && <SaveButton isPending={footerMutation.isPending} disabled={footerInvalid} />}
          {footerMutation.isSuccess && (
            <p className="text-sm text-success">{t('settings.pdfFooterSaved')}</p>
          )}
          {footerMutation.isError && (
            <p className="text-sm text-destructive">
              {getErrorMessage(footerMutation.error, t, 'settings.pdfBrandingSaveFailed')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
