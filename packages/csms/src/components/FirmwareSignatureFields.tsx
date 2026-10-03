// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { validateFirmwareSignature } from '@evtivity/lib/firmware-signature';
import type { FirmwareSignatureError } from '@evtivity/lib/firmware-signature';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

/** Signing certificate (PEM) and signature (base64) of a secure firmware update (L01). */
export interface FirmwareSignatureValue {
  signingCertificate: string;
  signature: string;
}

export interface FirmwareSignatureErrors {
  signingCertificate?: string;
  signature?: string;
}

const ERROR_KEYS = {
  incomplete: 'firmwareCampaigns.signingIncomplete',
  invalidCertificate: 'firmwareCampaigns.invalidSigningCertificate',
  certificateTooLong: 'firmwareCampaigns.signingCertificateTooLong',
  invalidSignature: 'firmwareCampaigns.invalidSignature',
  signatureTooLong: 'firmwareCampaigns.signatureTooLong',
} as const satisfies Record<FirmwareSignatureError, string>;

/** Field errors for the signing fields; empty when both are empty or both are valid. */
export function getFirmwareSignatureErrors(
  value: FirmwareSignatureValue,
  t: TFunction,
): FirmwareSignatureErrors {
  const certificate = value.signingCertificate.trim();
  const signature = value.signature.trim();
  const error = validateFirmwareSignature(certificate, signature);
  if (error == null) return {};
  const message = t(ERROR_KEYS[error]);
  if (error === 'incomplete') {
    return certificate === '' ? { signingCertificate: message } : { signature: message };
  }
  return error === 'invalidSignature' || error === 'signatureTooLong'
    ? { signature: message }
    : { signingCertificate: message };
}

/** The signing fields to send, or nothing for an unsigned update. */
export function firmwareSignaturePayload(
  value: FirmwareSignatureValue,
): { signingCertificate: string; signature: string } | Record<string, never> {
  const signingCertificate = value.signingCertificate.trim();
  const signature = value.signature.trim();
  return signingCertificate !== '' && signature !== '' ? { signingCertificate, signature } : {};
}

interface Props {
  value: FirmwareSignatureValue;
  onChange: (value: FirmwareSignatureValue) => void;
  idPrefix: string;
  errors?: FirmwareSignatureErrors;
}

export function FirmwareSignatureFields({
  value,
  onChange,
  idPrefix,
  errors = {},
}: Props): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('firmwareCampaigns.signingHint')}</p>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-signing-certificate`} className="leading-6">
          {t('firmwareCampaigns.signingCertificate')}
        </Label>
        <Textarea
          id={`${idPrefix}-signing-certificate`}
          rows={5}
          className={`font-mono text-xs ${errors.signingCertificate != null ? 'border-destructive' : ''}`}
          placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
          value={value.signingCertificate}
          onChange={(e) => {
            onChange({ ...value, signingCertificate: e.target.value });
          }}
        />
        {errors.signingCertificate != null && (
          <p className="text-sm text-destructive">{errors.signingCertificate}</p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-signature`} className="leading-6">
          {t('firmwareCampaigns.signature')}
        </Label>
        <Textarea
          id={`${idPrefix}-signature`}
          rows={3}
          className={`font-mono text-xs ${errors.signature != null ? 'border-destructive' : ''}`}
          value={value.signature}
          onChange={(e) => {
            onChange({ ...value, signature: e.target.value });
          }}
        />
        {errors.signature != null && <p className="text-sm text-destructive">{errors.signature}</p>}
      </div>
    </div>
  );
}
