// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { Label } from '@/components/ui/label';
import { Pagination } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { TabPanel } from '@/components/ui/tab-panel';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { CreateButton } from '@/components/create-button';
import { usePaginatedQuery } from '@/hooks/use-paginated-query';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { useUserTimezone } from '@/lib/timezone';
import { PairingFields, type PairingValue } from './PairingFields';
import { TerminalOnlineStatus } from './PaymentTerminalsTable';
import {
  PAYMENT_TERMINALS_KEY,
  terminalName,
  usePaymentTerminalFeature,
  type PaymentTerminal,
} from './payment-terminal-types';

const COLUMN_COUNT = 4;

/**
 * The payment terminals paired to a station (station Connectors tab), with Pair
 * for an unpaired terminal and New Payment Terminal with the station chosen.
 * Renders nothing without `paymentTerminals:read` or while the feature is off.
 */
export function StationPaymentTerminalsCard({
  stationId,
}: {
  stationId: string;
}): React.JSX.Element | null {
  const canRead = useHasPermission('paymentTerminals:read');
  const { available } = usePaymentTerminalFeature();
  if (!canRead || !available) return null;
  return <StationPaymentTerminalsPanel stationId={stationId} />;
}

function StationPaymentTerminalsPanel({ stationId }: { stationId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const timezone = useUserTimezone();
  const hasTerminalWrite = useHasPermission('paymentTerminals:write');
  const hasStationsWrite = useHasPermission('stations:write');
  const canPair = hasTerminalWrite && hasStationsWrite;
  const [pairOpen, setPairOpen] = useState(false);
  const [terminalId, setTerminalId] = useState('');
  const [pairing, setPairing] = useState<PairingValue>({ stationId, evseId: '' });
  const [pairSubmitted, setPairSubmitted] = useState(false);

  const { data, isLoading, isError, refetch, page, totalPages, setPage } =
    usePaginatedQuery<PaymentTerminal>(
      [...PAYMENT_TERMINALS_KEY, 'station', stationId],
      '/v1/payment-terminals',
      { stationId },
    );

  // The terminals that can be paired here: active and not paired to a station.
  const { data: candidates } = useQuery({
    queryKey: [...PAYMENT_TERMINALS_KEY, 'unpaired'],
    queryFn: () =>
      api.get<{ data: PaymentTerminal[]; total: number }>(
        '/v1/payment-terminals?status=active&limit=100',
      ),
    enabled: pairOpen,
  });
  const unpaired = (candidates?.data ?? []).filter((c) => c.stationId == null);

  const pair = useMutation({
    mutationFn: () =>
      api.post(`/v1/payment-terminals/${terminalId}/pair`, {
        stationId,
        evseId: pairing.evseId === '' ? null : pairing.evseId,
      }),
    onSuccess: () => {
      setPairOpen(false);
      toast({ variant: 'success', title: t('paymentTerminals.pairing.pairSuccess') });
      void queryClient.invalidateQueries({ queryKey: PAYMENT_TERMINALS_KEY });
    },
  });

  return (
    <TabPanel
      title={t('paymentTerminals.stationCard.title')}
      description={t('paymentTerminals.stationCard.description')}
      body="flush"
      actions={
        canPair ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                setTerminalId('');
                setPairing({ stationId, evseId: '' });
                setPairSubmitted(false);
                pair.reset();
                setPairOpen(true);
              }}
            >
              <Link2 className="h-4 w-4" />
              {t('paymentTerminals.pairing.pair')}
            </Button>
            <CreateButton
              label={t('paymentTerminals.create')}
              onClick={() => {
                void navigate(`/payment-terminals/new?stationId=${encodeURIComponent(stationId)}`);
              }}
            />
          </div>
        ) : undefined
      }
    >
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('paymentTerminals.columns.label')}</TableHead>
              <TableHead>{t('paymentTerminals.columns.connector')}</TableHead>
              <TableHead>{t('paymentTerminals.columns.status')}</TableHead>
              <TableHead>{t('paymentTerminals.columns.online')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <LoadingState />
              </TableStateRow>
            )}
            {isError && !isLoading && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <ErrorState
                  onRetry={() => {
                    refetch();
                  }}
                />
              </TableStateRow>
            )}
            {!isLoading && !isError && data?.length === 0 && (
              <TableStateRow colSpan={COLUMN_COUNT}>
                <EmptyState>{t('paymentTerminals.stationCard.empty')}</EmptyState>
              </TableStateRow>
            )}
            {data?.map((terminal) => (
              <TableRow
                key={terminal.id}
                className="cursor-pointer"
                data-testid={`station-terminal-row-${terminal.id}`}
                onClick={() => {
                  void navigate(`/payment-terminals/${terminal.id}`);
                }}
              >
                <TableCell className="font-medium text-link" data-testid="row-click-target">
                  {terminalName(terminal)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {terminal.evseNumber != null
                    ? t('paymentTerminals.connector', { number: terminal.evseNumber })
                    : t('paymentTerminals.wholeStation')}
                </TableCell>
                <TableCell>
                  <Badge variant={terminal.status === 'active' ? 'success' : 'secondary'}>
                    {t(`paymentTerminals.status.${terminal.status}`)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <TerminalOnlineStatus terminal={terminal} timezone={timezone} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <div className="px-6 pb-6">
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}
      <ConfirmDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        variant="default"
        asForm
        title={t('paymentTerminals.stationCard.pairTitle')}
        description={t('paymentTerminals.stationCard.pairDescription')}
        confirmLabel={t('paymentTerminals.pairing.pair')}
        isPending={pair.isPending}
        onConfirm={() => {
          setPairSubmitted(true);
          if (terminalId === '') return false;
          pair.mutate();
          return false;
        }}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="station-terminal-pick" className="leading-6">
              {t('paymentTerminals.stationCard.terminal')}
            </Label>
            <Select
              id="station-terminal-pick"
              value={terminalId}
              className={pairSubmitted && terminalId === '' ? 'border-destructive' : ''}
              onChange={(e) => {
                setTerminalId(e.target.value);
                pair.reset();
              }}
            >
              <option value="">{t('paymentTerminals.stationCard.selectTerminal')}</option>
              {unpaired.map((c) => (
                <option key={c.id} value={c.id}>
                  {terminalName(c)}
                </option>
              ))}
            </Select>
            {pairSubmitted && terminalId === '' && (
              <p className="text-sm text-destructive">{t('validation.selectRequired')}</p>
            )}
            {candidates != null && unpaired.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('paymentTerminals.stationCard.noUnpaired')}
              </p>
            )}
          </div>
          <PairingFields
            idPrefix="station-terminal-pair"
            value={pairing}
            fixedStationId={stationId}
            onChange={(next) => {
              setPairing(next);
              pair.reset();
            }}
          />
          {pair.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(pair.error, t)}</p>
          )}
        </div>
      </ConfirmDialog>
    </TabPanel>
  );
}
