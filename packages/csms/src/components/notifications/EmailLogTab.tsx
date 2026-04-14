// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { ResponsiveFilters } from '@/components/responsive-filters';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/search-input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import {
  OCPP_EVENT_TYPES,
  DRIVER_EVENT_TYPES,
  OPERATOR_EVENT_TYPES,
} from '@/lib/template-variables';
import { type NotificationRecord, statusBadgeClass, formatTimestamp } from './shared';

const EVENT_CATEGORIES: Record<string, readonly string[]> = {
  driver: DRIVER_EVENT_TYPES,
  system: OPERATOR_EVENT_TYPES,
  ocpp: OCPP_EVENT_TYPES,
};

export function EmailLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [selectedEmail, setSelectedEmail] = useState<NotificationRecord | null>(null);
  const [eventCategory, setEventCategory] = useState('');
  const [eventType, setEventType] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const extraParams = useMemo(() => {
    const params: Record<string, string> = { channel: 'email' };
    if (eventType) params.eventType = eventType;
    if (statusFilter) params.status = statusFilter;
    return params;
  }, [eventType, statusFilter]);

  const eventNames = eventCategory ? (EVENT_CATEGORIES[eventCategory] ?? []) : [];
  const activeFilterCount = (eventCategory ? 1 : 0) + (eventType ? 1 : 0) + (statusFilter ? 1 : 0);

  const {
    data: emails,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<NotificationRecord>('email-logs', '/v1/notifications', extraParams);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <SearchInput
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('logs.searchPlaceholder')}
        />
        <ResponsiveFilters activeCount={activeFilterCount}>
          <Select
            aria-label="Filter by event category"
            value={eventCategory}
            onChange={(e) => {
              setEventCategory(e.target.value);
              setEventType('');
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('notifications.allCategories')}</option>
            <option value="driver">{t('notifications.driverEvents')}</option>
            <option value="system">{t('notifications.systemEvents')}</option>
            <option value="ocpp">{t('notifications.ocppEvents')}</option>
          </Select>
          {eventCategory && (
            <Select
              aria-label="Filter by event type"
              value={eventType}
              onChange={(e) => {
                setEventType(e.target.value);
              }}
              className="h-9 w-auto"
            >
              <option value="">{t('notifications.allEvents')}</option>
              {eventNames.map((et) => (
                <option key={et} value={et}>
                  {et}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
            }}
            className="h-9 w-auto"
          >
            <option value="">{t('notifications.allStatuses')}</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
          </Select>
        </ResponsiveFilters>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.recipient')}</TableHead>
              <TableHead>{t('logs.subject')}</TableHead>
              <TableHead>{t('logs.eventType')}</TableHead>
              <TableHead>{t('logs.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {emails?.map((email) => (
              <TableRow
                key={email.id}
                className="cursor-pointer"
                data-testid={`email-log-row-${String(email.id)}`}
                onClick={() => {
                  setSelectedEmail(email);
                }}
              >
                <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                  {formatTimestamp(email.sentAt, email.createdAt)}
                </TableCell>
                <TableCell>{email.recipient}</TableCell>
                <TableCell className="max-w-[300px] truncate">{email.subject ?? '-'}</TableCell>
                <TableCell>{email.eventType ?? '-'}</TableCell>
                <TableCell>
                  <Badge className={statusBadgeClass(email.status)}>{email.status}</Badge>
                </TableCell>
              </TableRow>
            ))}
            {emails?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground">
                  {t('logs.noEmails')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <Dialog
        open={selectedEmail != null}
        onOpenChange={(open) => {
          if (!open) setSelectedEmail(null);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t('logs.emailPreview')}</DialogTitle>
            {selectedEmail != null && (
              <div className="text-sm text-muted-foreground space-y-1 pt-2">
                <p>
                  <span className="font-medium">{t('logs.recipient')}:</span>{' '}
                  {selectedEmail.recipient}
                </p>
                <p>
                  <span className="font-medium">{t('logs.subject')}:</span>{' '}
                  {selectedEmail.subject ?? '-'}
                </p>
                <p>
                  <span className="font-medium">{t('logs.eventType')}:</span>{' '}
                  {selectedEmail.eventType ?? '-'}
                </p>
                <p>
                  <span className="font-medium">{t('logs.status')}:</span>{' '}
                  <Badge className={statusBadgeClass(selectedEmail.status)}>
                    {selectedEmail.status}
                  </Badge>
                </p>
              </div>
            )}
          </DialogHeader>
          {selectedEmail != null && (
            <iframe
              title={t('logs.emailPreview')}
              srcDoc={selectedEmail.body}
              className="w-full flex-1 min-h-[400px] bg-white border rounded-md"
              sandbox=""
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
