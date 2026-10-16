// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { useHasPermission } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { formatCents } from '@/lib/formatting';
import { BillToButton } from '@/components/bill-to-button';
import { useBillingRecipientMove } from './use-billing-recipient-move';

/** A member row of GET /v1/fleets/:id/billing/unbilled (`members`). */
export interface FleetMemberPreview {
  driverId: string;
  driverName: string;
  sessionCount: number;
  energyWh: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
  existingInvoice: { id: string; invoiceNumber: string; status: string } | null;
  hasEmail: boolean;
  hasAddress: boolean;
}

export interface FleetMemberInvoicesProps {
  fleetId: string;
  period: string;
  monthLabel: string;
  currency: string;
  members: FleetMemberPreview[];
  /** Called after "Invoice All Members" was handed to the worker: the preview follows it. */
  onBatchStarted: () => void;
}

/** A driver the member invoice of the period can be generated for. */
export function canInvoiceMember(member: FleetMemberPreview): boolean {
  return member.existingInvoice == null && member.sessionCount > 0 && member.totalCents > 0;
}

/**
 * The member invoices of a period on the fleet Billing tab: each driver with
 * unbilled member-billed sessions or a live member invoice, with Generate per
 * driver and "Invoice All Members" (issued in the background).
 */
export function FleetMemberInvoices({
  fleetId,
  period,
  monthLabel,
  currency,
  members,
  onBatchStarted,
}: FleetMemberInvoicesProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = useHasPermission('payments:write');
  const [target, setTarget] = useState<FleetMemberPreview | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const pending = members.filter(canInvoiceMember);
  const money = (cents: number): string => formatCents(cents, currency);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId] });
    void queryClient.invalidateQueries({ queryKey: ['invoices'] });
  }

  const generate = useMutation({
    mutationFn: (driverId: string) =>
      api.post<{ emailed: boolean }>(`/v1/fleets/${fleetId}/member-invoices`, {
        period,
        driverId,
      }),
    onSuccess: (result) => {
      toast({
        variant: 'success',
        title: result.emailed
          ? t('fleets.invoices.memberGenerated')
          : t('fleets.invoices.memberGeneratedNotSent'),
      });
      setTarget(null);
      refresh();
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
      setTarget(null);
    },
  });

  const invoiceAll = useMutation({
    mutationFn: () =>
      api.post<{ batchId: string; memberCount: number }>(
        `/v1/fleets/${fleetId}/member-invoices/batch`,
        { period },
      ),
    onSuccess: (result) => {
      toast({
        variant: 'success',
        title: t('fleets.invoices.invoiceAllStarted', { count: result.memberCount }),
      });
      setAllOpen(false);
      onBatchStarted();
      refresh();
    },
    onError: (err: unknown) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
      setAllOpen(false);
    },
  });

  const move = useBillingRecipientMove(fleetId, period);
  // Members with unbilled sessions that can go back on the fleet invoice.
  const movable = members.filter((m) => m.sessionCount > 0).map((m) => m.driverId);

  return (
    <div className="space-y-3" data-testid="fleet-member-invoices">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <p className="font-medium">{t('fleets.invoices.membersTitle')}</p>
          <p className="text-muted-foreground">{t('fleets.invoices.membersDescription')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {move.canMove && movable.length > 0 && (
            <BillToButton
              recipient="fleet"
              label={t('billingRecipient.billAllToFleet')}
              onClick={() => {
                move.request({ recipient: 'fleet', driverIds: movable, driverName: null });
              }}
            />
          )}
          {canWrite && (
            <Button
              variant="outline"
              disabled={pending.length === 0 || invoiceAll.isPending}
              onClick={() => {
                setAllOpen(true);
              }}
            >
              {t('fleets.invoices.invoiceAll')}
            </Button>
          )}
        </div>
      </div>
      {members.length === 0 ? (
        <p className="text-muted-foreground">{t('fleets.invoices.noMembers')}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('fleets.invoices.driver')}</TableHead>
                <TableHead className="text-right">{t('fleets.invoices.sessions')}</TableHead>
                <TableHead className="text-right">{t('fleets.invoices.total')}</TableHead>
                <TableHead>{t('fleets.invoices.invoice')}</TableHead>
                <TableHead className="text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.driverId} data-testid={`member-row-${member.driverId}`}>
                  <TableCell>
                    <Link to={`/drivers/${member.driverId}`} className="text-link hover:underline">
                      {member.driverName !== '' ? member.driverName : t('invoices.unknownDriver')}
                    </Link>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {!member.hasEmail && (
                        <Badge variant="warning">{t('fleets.invoices.noEmail')}</Badge>
                      )}
                      {!member.hasAddress && (
                        <Badge variant="outline">{t('fleets.invoices.noAddress')}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{member.sessionCount}</TableCell>
                  <TableCell className="text-right">{money(member.totalCents)}</TableCell>
                  <TableCell>
                    {member.existingInvoice != null ? (
                      <Link
                        to={`/invoices/${member.existingInvoice.id}`}
                        className="text-link hover:underline"
                      >
                        {member.existingInvoice.invoiceNumber}
                      </Link>
                    ) : (
                      '--'
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {move.canMove && member.sessionCount > 0 && (
                        <BillToButton
                          recipient="fleet"
                          onClick={() => {
                            move.request({
                              recipient: 'fleet',
                              driverIds: [member.driverId],
                              driverName: member.driverName,
                            });
                          }}
                        />
                      )}
                      {canWrite && (
                        <Button
                          disabled={!canInvoiceMember(member) || generate.isPending}
                          onClick={() => {
                            setTarget(member);
                          }}
                        >
                          {t('fleets.invoices.generateMember')}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={target != null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        variant="default"
        title={t('fleets.invoices.generateMemberTitle')}
        description={t('fleets.invoices.generateMemberConfirm', {
          period: monthLabel,
          driver: target?.driverName ?? '',
          total: target != null ? money(target.totalCents) : '',
        })}
        confirmLabel={t('fleets.invoices.generateMember')}
        isPending={generate.isPending}
        onConfirm={() => {
          if (target != null) generate.mutate(target.driverId);
          return false;
        }}
      />
      {move.dialog}
      <ConfirmDialog
        open={allOpen}
        onOpenChange={setAllOpen}
        variant="default"
        title={t('fleets.invoices.invoiceAll')}
        description={t('fleets.invoices.invoiceAllConfirm', {
          period: monthLabel,
          count: pending.length,
        })}
        confirmLabel={t('fleets.invoices.invoiceAll')}
        isPending={invoiceAll.isPending}
        onConfirm={() => {
          invoiceAll.mutate();
          return false;
        }}
      />
    </div>
  );
}
