// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { CreateButton } from '@/components/create-button';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PaymentMethodForm } from '@/components/PaymentMethodForm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/timezone';

interface DriverPaymentMethod {
  id: number;
  driverId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface DriverPaymentMethodsTabProps {
  driverId: string;
  timezone: string;
}

export function DriverPaymentMethodsTab({
  driverId,
  timezone,
}: DriverPaymentMethodsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [addingPaymentMethod, setAddingPaymentMethod] = useState(false);
  const [deletePaymentMethodId, setDeletePaymentMethodId] = useState<number | null>(null);

  const { data: paymentMethods } = useQuery({
    queryKey: ['drivers', driverId, 'payment-methods'],
    queryFn: () => api.get<DriverPaymentMethod[]>(`/v1/drivers/${driverId}/payment-methods`),
  });

  const deletePaymentMethodMutation = useMutation({
    mutationFn: (pmId: number) =>
      api.delete(`/v1/drivers/${driverId}/payment-methods/${String(pmId)}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'payment-methods'] });
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: (pmId: number) =>
      api.patch(`/v1/drivers/${driverId}/payment-methods/${String(pmId)}/default`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['drivers', driverId, 'payment-methods'] });
    },
  });

  return (
    <TabsContent value="payment-methods">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('payments.paymentMethods')}</CardTitle>
          {!addingPaymentMethod && (
            <CreateButton
              label={t('payments.createPaymentMethod')}
              onClick={() => {
                setAddingPaymentMethod(true);
              }}
            />
          )}
        </CardHeader>
        <CardContent>
          {addingPaymentMethod ? (
            <PaymentMethodForm
              driverId={driverId}
              onSuccess={() => {
                setAddingPaymentMethod(false);
                void queryClient.invalidateQueries({
                  queryKey: ['drivers', driverId, 'payment-methods'],
                });
              }}
              onCancel={() => {
                setAddingPaymentMethod(false);
              }}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('payments.cardBrand')}</TableHead>
                    <TableHead>{t('payments.cardLast4')}</TableHead>
                    <TableHead>{t('payments.default')}</TableHead>
                    <TableHead>{t('common.created')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paymentMethods?.map((pm) => (
                    <TableRow key={pm.id}>
                      <TableCell className="capitalize">{pm.cardBrand ?? '-'}</TableCell>
                      <TableCell>{pm.cardLast4 != null ? `****${pm.cardLast4}` : '-'}</TableCell>
                      <TableCell>
                        {pm.isDefault ? (
                          <Badge variant="default">{t('payments.default')}</Badge>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setDefaultMutation.mutate(pm.id);
                            }}
                            disabled={setDefaultMutation.isPending}
                          >
                            {t('payments.setAsDefault')}
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(pm.createdAt, timezone)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDeletePaymentMethodId(pm.id);
                          }}
                          disabled={deletePaymentMethodMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {(paymentMethods == null || paymentMethods.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {t('payments.noPaymentMethods')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
          <ConfirmDialog
            open={deletePaymentMethodId != null}
            onOpenChange={(open) => {
              if (!open) setDeletePaymentMethodId(null);
            }}
            title={t('common.delete')}
            description={t('payments.confirmDeletePaymentMethod', {
              brand:
                paymentMethods?.find((pm) => pm.id === deletePaymentMethodId)?.cardBrand ?? 'Card',
              last4:
                paymentMethods?.find((pm) => pm.id === deletePaymentMethodId)?.cardLast4 ?? '****',
            })}
            confirmLabel={t('common.delete')}
            onConfirm={() => {
              if (deletePaymentMethodId != null) {
                deletePaymentMethodMutation.mutate(deletePaymentMethodId);
              }
            }}
            variant="destructive"
            isPending={deletePaymentMethodMutation.isPending}
          />
        </CardContent>
      </Card>
    </TabsContent>
  );
}
