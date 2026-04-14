// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';

interface Holiday {
  id: number;
  name: string;
  date: string;
  createdAt: string;
}

export function PricingHolidays(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Holiday | null>(null);

  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [bulkText, setBulkText] = useState('');

  const { data: holidays, isLoading } = useQuery({
    queryKey: ['pricing-holidays'],
    queryFn: () => api.get<Holiday[]>('/v1/pricing-holidays'),
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; date: string }) => api.post('/v1/pricing-holidays', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-holidays'] });
      setCreateOpen(false);
      setName('');
      setDate('');
    },
  });

  const bulkMutation = useMutation({
    mutationFn: (body: { holidays: { name: string; date: string }[] }) =>
      api.post('/v1/pricing-holidays/bulk', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-holidays'] });
      setBulkOpen(false);
      setBulkText('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/v1/pricing-holidays/${String(id)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-holidays'] });
      setDeleteTarget(null);
    },
  });

  function handleCreate(): void {
    if (name.trim() === '' || date.trim() === '') return;
    createMutation.mutate({ name: name.trim(), date: date.trim() });
  }

  function handleBulkAdd(): void {
    const lines = bulkText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const parsed: { name: string; date: string }[] = [];
    for (const line of lines) {
      const match = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line);
      if (match != null && match[1] != null && match[2] != null) {
        parsed.push({ date: match[1], name: match[2].trim() });
      }
    }

    if (parsed.length === 0) return;
    bulkMutation.mutate({ holidays: parsed });
  }

  const sorted = holidays != null ? [...holidays].sort((a, b) => a.date.localeCompare(b.date)) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link
          to="/pricing"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {t('pricing.title')}
        </Link>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('pricing.holidays')}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setBulkOpen(true);
            }}
          >
            {t('pricing.bulkAdd')}
          </Button>
          <Button
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t('pricing.addHoliday')}
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}

      {sorted.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">{t('pricing.noHolidays')}</p>
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('pricing.holidayDate')}</TableHead>
                <TableHead>{t('pricing.holidayName')}</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((holiday) => (
                <TableRow key={holiday.id}>
                  <TableCell>{holiday.date}</TableCell>
                  <TableCell>{holiday.name}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('pricing.deleteHoliday')}
                      onClick={() => {
                        setDeleteTarget(holiday);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pricing.addHoliday')}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
            noValidate
          >
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="holiday-name">{t('pricing.holidayName')}</Label>
                <Input
                  id="holiday-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  placeholder="New Year's Day"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="holiday-date">{t('pricing.holidayDate')}</Label>
                <Input
                  id="holiday-date"
                  type="date"
                  aria-label="Holiday date"
                  value={date}
                  onChange={(e) => {
                    setDate(e.target.value);
                  }}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateOpen(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={createMutation.isPending || name.trim() === '' || date.trim() === ''}
              >
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('pricing.bulkAdd')}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label>{t('pricing.holidays')}</Label>
            <textarea
              className="flex min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={bulkText}
              onChange={(e) => {
                setBulkText(e.target.value);
              }}
              placeholder={t('pricing.bulkAddPlaceholder')}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setBulkOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleBulkAdd}
              disabled={bulkMutation.isPending || bulkText.trim() === ''}
            >
              {t('pricing.bulkAdd')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget != null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t('pricing.deleteHoliday')}
        description={deleteTarget != null ? `${deleteTarget.name} (${deleteTarget.date})` : ''}
        confirmLabel={t('common.delete')}
        onConfirm={() => {
          if (deleteTarget != null) {
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
        isPending={deleteMutation.isPending}
        variant="destructive"
      />
    </div>
  );
}
