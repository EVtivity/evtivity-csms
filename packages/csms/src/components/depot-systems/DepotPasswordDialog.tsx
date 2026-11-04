// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The sign-in of a bus depot system, shown once after a create or a new
 * password: the user name (its system ID) and the password to give the vendor.
 */
export function DepotPasswordDialog({
  credentials,
  onClose,
}: {
  credentials: { presystemId: string; password: string } | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Dialog
      open={credentials != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('depotSystems.passwordTitle')}</DialogTitle>
          <DialogDescription>{t('depotSystems.passwordDescription')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Alert variant="warning">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{t('depotSystems.passwordShownOnce')}</AlertDescription>
          </Alert>
          <div className="grid gap-2">
            <Label htmlFor="depot-credentials-user">{t('depotSystems.userName')}</Label>
            <div className="flex gap-2">
              <Input
                id="depot-credentials-user"
                value={credentials?.presystemId ?? ''}
                readOnly
                className="flex-1 font-mono"
              />
              <CopyButton value={credentials?.presystemId ?? ''} size="icon" />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="depot-credentials-password">{t('depotSystems.password')}</Label>
            <div className="flex gap-2">
              <Input
                id="depot-credentials-password"
                value={credentials?.password ?? ''}
                readOnly
                className="flex-1 font-mono"
                data-testid="depot-password"
              />
              <CopyButton value={credentials?.password ?? ''} size="icon" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('common.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
