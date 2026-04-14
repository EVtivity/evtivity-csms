// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CopyableId } from '@/components/copyable-id';
import { Pagination } from '@/components/ui/pagination';
import { formatDate } from '@/lib/timezone';

export interface Token {
  id: string;
  driverId?: string | null;
  idToken: string;
  tokenType: string;
  isActive: boolean;
  createdAt: string;
  driverFirstName?: string | null;
  driverLastName?: string | null;
}

interface TokensTableProps {
  tokens: Token[] | undefined;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  timezone: string;
  isLoading?: boolean;
  showDriver?: boolean;
  emptyMessage?: string;
}

export function TokensTable({
  tokens,
  page,
  totalPages,
  onPageChange,
  timezone,
  isLoading,
  showDriver = true,
  emptyMessage,
}: TokensTableProps): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const colSpan = showDriver ? 6 : 5;

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('tokens.token')}</TableHead>
              {showDriver && <TableHead>{t('tokens.driver')}</TableHead>}
              <TableHead>{t('tokens.tokenId')}</TableHead>
              <TableHead>{t('tokens.type')}</TableHead>
              <TableHead>{t('common.status')}</TableHead>
              <TableHead>{t('common.created')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading === true && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                  {t('common.loading')}
                </TableCell>
              </TableRow>
            )}
            {tokens?.map((token) => (
              <TableRow
                key={token.id}
                className="cursor-pointer"
                data-testid={`token-row-${token.id}`}
                onClick={() => {
                  void navigate(`/tokens/${token.id}`);
                }}
              >
                <TableCell>
                  <CopyableId id={token.idToken} variant="table" className="text-primary" />
                </TableCell>
                {showDriver && (
                  <TableCell>
                    {token.driverId != null && token.driverFirstName != null ? (
                      <Link
                        to={`/drivers/${token.driverId}`}
                        className="text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        {token.driverFirstName} {token.driverLastName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">{t('tokens.unassigned')}</span>
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <CopyableId id={token.id} variant="table" />
                </TableCell>
                <TableCell data-testid="row-click-target">{token.tokenType}</TableCell>
                <TableCell>
                  <Badge variant={token.isActive ? 'default' : 'secondary'}>
                    {token.isActive ? t('common.active') : t('common.inactive')}
                  </Badge>
                </TableCell>
                <TableCell>{formatDate(token.createdAt, timezone)}</TableCell>
              </TableRow>
            ))}
            {tokens?.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} className="text-center text-muted-foreground">
                  {emptyMessage ?? t('tokens.noTokensFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={onPageChange} />
    </>
  );
}
