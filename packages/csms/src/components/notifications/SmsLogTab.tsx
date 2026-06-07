// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { FilterPopover } from '@/components/FilterBar';
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
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import {
  OCPP_EVENT_TYPES,
  DRIVER_EVENT_TYPES,
  OPERATOR_EVENT_TYPES,
} from '@/lib/template-variables';
import { type NotificationRecord, formatTimestamp, formatRecipient } from './shared';
import { StatusCell } from './StatusCell';
import { LoadingLogo } from '@/components/loading-logo';

const EVENT_CATEGORIES: Record<string, readonly string[]> = {
  driver: DRIVER_EVENT_TYPES,
  system: OPERATOR_EVENT_TYPES,
  ocpp: OCPP_EVENT_TYPES,
};

export function SmsLogTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [eventCategory, setEventCategory] = useState('');
  const [eventType, setEventType] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const extraParams = useMemo(() => {
    const params: Record<string, string> = { channel: 'sms' };
    if (eventType) params.eventType = eventType;
    if (statusFilter) params.status = statusFilter;
    return params;
  }, [eventType, statusFilter]);

  const eventNames = eventCategory ? (EVENT_CATEGORIES[eventCategory] ?? []) : [];
  const activeFilterCount = (eventCategory ? 1 : 0) + (eventType ? 1 : 0) + (statusFilter ? 1 : 0);

  const {
    data: messages,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<NotificationRecord>('sms-logs', '/v1/notifications', extraParams);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <SearchInput
          className="flex-1 md:max-w-xs"
          value={search}
          onDebouncedChange={setSearch}
          placeholder={t('logs.searchPlaceholder')}
        />
        <Select
          aria-label={t('common.filterByEventCategory')}
          value={eventCategory}
          onChange={(e) => {
            setEventCategory(e.target.value);
            setEventType('');
          }}
          className="hidden h-9 w-auto md:block"
        >
          <option value="">{t('notifications.allCategories')}</option>
          <option value="driver">{t('notifications.driverEvents')}</option>
          <option value="system">{t('notifications.systemEvents')}</option>
          <option value="ocpp">{t('notifications.ocppEvents')}</option>
        </Select>
        {eventCategory && (
          <Select
            aria-label={t('common.filterByEventType')}
            value={eventType}
            onChange={(e) => {
              setEventType(e.target.value);
            }}
            className="hidden h-9 w-auto md:block"
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
          aria-label={t('common.filterByStatus')}
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
          }}
          className="hidden h-9 w-auto md:block"
        >
          <option value="">{t('notifications.allStatuses')}</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </Select>
        <FilterPopover className="md:hidden" activeCount={activeFilterCount}>
          <Select
            aria-label={t('common.filterByEventCategory')}
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
              aria-label={t('common.filterByEventType')}
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
            aria-label={t('common.filterByStatus')}
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
        </FilterPopover>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('common.timestamp')}</TableHead>
              <TableHead>{t('logs.recipient')}</TableHead>
              <TableHead>{t('logs.eventType')}</TableHead>
              <TableHead>{t('logs.status')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  <LoadingLogo size="inline" />
                </TableCell>
              </TableRow>
            )}
            {messages?.map((msg) => (
              <Fragment key={msg.id}>
                <TableRow
                  className="cursor-pointer"
                  data-testid={`sms-log-row-${String(msg.id)}`}
                  onClick={() => {
                    setExpandedId(expandedId === msg.id ? null : msg.id);
                  }}
                >
                  <TableCell className="whitespace-nowrap" data-testid="row-click-target">
                    {formatTimestamp(msg.sentAt, msg.createdAt)}
                  </TableCell>
                  <TableCell>{formatRecipient(msg.recipient)}</TableCell>
                  <TableCell>{msg.eventType ?? '-'}</TableCell>
                  <TableCell>
                    <StatusCell status={msg.status} metadata={msg.metadata} />
                  </TableCell>
                </TableRow>
                {expandedId === msg.id && (
                  <TableRow>
                    <TableCell colSpan={4} className="bg-muted/30 p-4">
                      <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {messages?.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {t('logs.noSms')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
