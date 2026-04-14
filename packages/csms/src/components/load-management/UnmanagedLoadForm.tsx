// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import { api } from '@/lib/api';

interface UnmanagedLoadFormProps {
  siteId: string;
  panelId?: string;
  circuitId?: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function UnmanagedLoadForm({
  siteId,
  panelId,
  circuitId,
  open,
  onClose,
  onSaved,
}: UnmanagedLoadFormProps): React.JSX.Element {
  const { t } = useTranslation();

  const [name, setName] = useState('');
  const [estimatedDrawKw, setEstimatedDrawKw] = useState(0);

  useEffect(() => {
    if (open) {
      setName('');
      setEstimatedDrawKw(0);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name, estimatedDrawKw };
      if (panelId != null) body['panelId'] = panelId;
      if (circuitId != null) body['circuitId'] = circuitId;
      return api.post(`/v1/sites/${siteId}/unmanaged-loads`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('loadManagement.addUnmanagedLoad')}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-6">
          <div className="grid gap-2">
            <Label htmlFor="load-name">{t('loadManagement.loadName')}</Label>
            <Input
              id="load-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              required
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="estimated-draw">{t('loadManagement.estimatedDraw')}</Label>
            <Input
              id="estimated-draw"
              type="number"
              min={0}
              step={0.1}
              value={estimatedDrawKw}
              onChange={(e) => {
                setEstimatedDrawKw(Number(e.target.value));
              }}
              required
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <SaveButton isPending={mutation.isPending} />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
