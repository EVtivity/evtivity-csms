// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { CreateButton } from '@/components/create-button';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';
import { roamingPartnerStatusVariant } from '@/lib/status-variants';

interface Partner {
  id: string;
  name: string;
  countryCode: string;
  partyId: string;
  status: string;
  version: string | null;
  createdAt: string;
  updatedAt: string;
}

export function RoamingPartners(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const timezone = useUserTimezone();

  const {
    data: partners,
    isLoading,
    page,
    totalPages,
    setPage,
    search,
    setSearch,
  } = usePaginatedQuery<Partner>('ocpi-partners', '/v1/ocpi/partners');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">{t('roaming.partners.title')}</h1>
        <CreateButton
          label={t('roaming.partners.addPartner')}
          onClick={() => {
            void navigate('/roaming/partners/new');
          }}
        />
      </div>

      <Input
        placeholder={t('common.search')}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        className="max-w-sm"
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('roaming.partners.partnerName')}</TableHead>
            <TableHead>{t('roaming.partners.partnerId')}</TableHead>
            <TableHead>{t('roaming.partners.countryParty')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead>{t('roaming.partners.version')}</TableHead>
            <TableHead>{t('common.created')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center">
                {t('common.loading')}
              </TableCell>
            </TableRow>
          ) : partners == null || partners.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground">
                {t('roaming.partners.noPartners')}
              </TableCell>
            </TableRow>
          ) : (
            partners.map((partner) => (
              <TableRow
                key={partner.id}
                className="cursor-pointer"
                data-testid={`roaming-partner-row-${partner.id}`}
                onClick={() => {
                  void navigate(`/roaming/partners/${partner.id}`);
                }}
              >
                <TableCell className="font-medium" data-testid="row-click-target">
                  {partner.name}
                </TableCell>
                <TableCell className="whitespace-nowrap">{partner.id}</TableCell>
                <TableCell>
                  {partner.countryCode}-{partner.partyId}
                </TableCell>
                <TableCell>
                  <Badge variant={roamingPartnerStatusVariant(partner.status)}>
                    {partner.status}
                  </Badge>
                </TableCell>
                <TableCell>{partner.version ?? '-'}</TableCell>
                <TableCell>{formatDateTime(partner.createdAt, timezone)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />}
    </div>
  );
}
