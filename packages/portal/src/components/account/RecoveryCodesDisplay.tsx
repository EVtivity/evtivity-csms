// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  recoveryCodesFileDate,
  recoveryCodesFileName,
  recoveryCodesFileText,
  saveTextFile,
} from '@/lib/recovery-codes-file';

/**
 * New MFA recovery codes, shown once after MFA is turned on or the codes are
 * regenerated: the server keeps only their hashes.
 */
export function RecoveryCodesDisplay({
  codes,
  onDone,
  accountEmail,
}: {
  codes: string[];
  onDone: () => void;
  /** The account the codes belong to, before the sign-in finished (required MFA setup). */
  accountEmail?: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const signedInEmail = useAuth((s) => s.driver?.email);
  const email = accountEmail ?? signedInEmail;
  const { data: branding } = useQuery({
    queryKey: ['branding'],
    queryFn: () => api.get<{ name?: string }>('/v1/portal/branding'),
  });

  function download(): void {
    const date = recoveryCodesFileDate();
    const header =
      email != null && email !== ''
        ? t('profile.recoveryCodesFileHeader', { email, date })
        : t('profile.recoveryCodesFileHeaderNoEmail', { date });
    saveTextFile(recoveryCodesFileName(branding?.name), recoveryCodesFileText(header, codes));
  }

  return (
    <div className="space-y-4" data-testid="recovery-codes">
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t('profile.recoveryCodesTitle')}</AlertTitle>
        <AlertDescription>{t('profile.recoveryCodesStoreNote')}</AlertDescription>
      </Alert>
      <ul
        aria-label={t('profile.recoveryCodesTitle')}
        className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-muted px-4 py-3 font-mono text-sm"
      >
        {codes.map((code) => (
          <li key={code} className="select-all">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={codes.join('\n')} text={t('profile.recoveryCodesCopy')} size="default" />
        <Button type="button" variant="outline" onClick={download}>
          <Download className="h-4 w-4" />
          {t('profile.recoveryCodesDownload')}
        </Button>
        <Button onClick={onDone}>{t('profile.recoveryCodesDone')}</Button>
      </div>
    </div>
  );
}
