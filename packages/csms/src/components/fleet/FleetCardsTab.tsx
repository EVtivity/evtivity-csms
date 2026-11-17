// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PORTAL_ID_TOKEN_TYPES } from '@evtivity/lib/id-token-types';
import { TabPanel } from '@/components/ui/tab-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState, LoadingState, TableStateRow } from '@/components/ui/content-state';
import { GuidedEmptyState } from '@/components/ui/guided-empty-state';
import { CreateButton } from '@/components/create-button';
import { ImportButton } from '@/components/import-button';
import { FleetCardImportDialog } from '@/components/fleet/FleetCardImportDialog';
import { EditIconButton } from '@/components/edit-icon-button';
import { HistoryIconButton } from '@/components/history-icon-button';
import { FleetCardHistoryDialog } from '@/components/fleet/FleetCardHistoryDialog';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { SaveButton } from '@/components/save-button';
import { SearchInput } from '@/components/search-input';
import { useSavedToast } from '@/components/saved-message';
import {
  FleetMemberCombobox,
  fleetMemberName,
  type FleetMemberSelection,
} from '@/components/fleet/FleetMemberCombobox';
import { api } from '@/lib/api';
import { useHasAllSiteAccess, useHasPermission, useIsFleetUser } from '@/lib/auth';
import { getErrorMessage } from '@/lib/error-message';
import { useCompanyCurrency } from '@/hooks/use-company-currency';
import {
  FleetCardMonthSpend,
  FleetCardMonthlyLimitField,
  monthlyLimitInput,
  parseMonthlyLimitInput,
} from '@/components/fleet/FleetCardMonthlyLimitField';

export type FleetCardStatus = 'active' | 'suspended' | 'deactivated';

export interface FleetCard {
  id: string;
  idToken: string;
  tokenType: string;
  label: string | null;
  isActive: boolean;
  status: FleetCardStatus;
  blockedByOperator: boolean;
  driver: { id: string; firstName: string | null; lastName: string | null } | null;
  monthlyLimitCents: number | null;
  /** Null without payments:read, or for a site-restricted operator. */
  monthSpentCents: number | null;
  createdAt: string;
  updatedAt: string;
}

const PAGE_SIZE = 10;

const STATUS_VARIANT: Record<FleetCardStatus, 'success' | 'warning' | 'outline'> = {
  active: 'success',
  suspended: 'warning',
  deactivated: 'outline',
};

/** The member a card is given to, as the member picker shows it. */
function cardMember(card: FleetCard): FleetMemberSelection | null {
  return card.driver == null ? null : { id: card.driver.id, name: fleetMemberName(card.driver) };
}

/**
 * Why the active checkbox of a card is locked, or null: a deactivated card is
 * never turned on again here, and a fleet user cannot turn on a card an
 * operator turned off.
 */
export function fleetCardActiveLock(
  card: Pick<FleetCard, 'status' | 'blockedByOperator'>,
  isFleetUser: boolean,
): 'deactivated' | 'blockedByOperator' | null {
  if (card.status === 'deactivated') return 'deactivated';
  if (card.blockedByOperator && isFleetUser) return 'blockedByOperator';
  return null;
}

interface FleetCardsTabProps {
  fleetId: string;
}

/**
 * The RFID cards a fleet owns: list, add and edit (a fleet user turns a card
 * off or on there); only an operator deactivates a card for good.
 */
export function FleetCardsTab({ fleetId }: FleetCardsTabProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isFleetUser = useIsFleetUser();
  // Fleet card writes are for the fleet's own users and all-site operators.
  const allSites = useHasAllSiteAccess();
  const canWrite = useHasPermission('fleetCards:write') && (isFleetUser || allSites);
  const canDeactivate = canWrite && !isFleetUser;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editCard, setEditCard] = useState<FleetCard | null>(null);
  const [deactivateCard, setDeactivateCard] = useState<FleetCard | null>(null);
  const [historyCard, setHistoryCard] = useState<FleetCard | null>(null);
  const currency = useCompanyCurrency().currency ?? '';

  const query = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
  if (search !== '') query.set('search', search);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['fleets', fleetId, 'cards', page, search],
    queryFn: () =>
      api.get<{ data: FleetCard[]; total: number }>(
        `/v1/fleets/${fleetId}/cards?${query.toString()}`,
      ),
  });

  const deactivate = useMutation({
    mutationFn: (card: FleetCard) => api.delete(`/v1/fleets/${fleetId}/cards/${card.id}`),
    onSuccess: () => {
      setDeactivateCard(null);
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'cards'] });
    },
  });

  const rows = data?.data ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const colSpan = 7;
  // A fleet without any card yet: the empty list says how to start and holds the add actions.
  const noCardsYet = !isLoading && !isError && rows.length === 0 && search === '';
  const showHeaderActions = canWrite && !noCardsYet;
  const openImport = (): void => {
    setImportOpen(true);
  };
  const openAdd = (): void => {
    setAddOpen(true);
  };

  return (
    <>
      <TabPanel
        title={t('fleets.cards.title')}
        description={t('fleets.cards.description')}
        actions={
          <>
            <SearchInput
              value={search}
              onDebouncedChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
              placeholder={t('fleets.cards.searchPlaceholder')}
              className="sm:min-w-40 sm:max-w-sm sm:flex-1"
            />
            {showHeaderActions && (
              <ImportButton label={t('fleets.cards.import.open')} onClick={openImport} />
            )}
            {showHeaderActions && (
              <CreateButton
                label={t('fleets.cards.addCard')}
                testId="fleet-card-add"
                onClick={openAdd}
              />
            )}
          </>
        }
        actionsPosition="fill"
      >
        {noCardsYet ? (
          // Outside the table: on a phone the wide table would center the text off screen.
          <GuidedEmptyState
            title={t('fleets.cards.empty.title')}
            description={t(
              canWrite ? 'fleets.cards.empty.description' : 'fleets.cards.empty.readOnly',
            )}
            actions={
              canWrite ? (
                <>
                  <ImportButton label={t('fleets.cards.import.open')} onClick={openImport} />
                  <CreateButton
                    label={t('fleets.cards.addCard')}
                    testId="fleet-card-add"
                    onClick={openAdd}
                  />
                </>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fleets.cards.value')}</TableHead>
                  <TableHead>{t('tokens.type')}</TableHead>
                  <TableHead>{t('tokens.label')}</TableHead>
                  <TableHead>{t('fleets.cards.member')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead>{t('fleets.cards.monthlyLimit.column')}</TableHead>
                  <TableHead className="text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableStateRow colSpan={colSpan}>
                    <LoadingState />
                  </TableStateRow>
                )}
                {isError && (
                  <TableStateRow colSpan={colSpan}>
                    <ErrorState
                      onRetry={() => {
                        void refetch();
                      }}
                    />
                  </TableStateRow>
                )}
                {!isLoading && !isError && rows.length === 0 && search !== '' && (
                  <TableStateRow colSpan={colSpan}>
                    <EmptyState>{t('fleets.cards.noCards')}</EmptyState>
                  </TableStateRow>
                )}
                {rows.map((card) => (
                  <TableRow key={card.id} data-testid={`fleet-card-row-${card.id}`}>
                    <TableCell className="font-medium wrap-anywhere">{card.idToken}</TableCell>
                    <TableCell>{card.tokenType}</TableCell>
                    <TableCell className="wrap-anywhere">{card.label ?? ''}</TableCell>
                    <TableCell>
                      {card.driver != null ? (
                        fleetMemberName(card.driver)
                      ) : (
                        <span className="text-muted-foreground">{t('fleets.cards.noMember')}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[card.status]}>
                        {t(`fleets.cards.status.${card.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      <FleetCardMonthSpend
                        spentCents={card.monthSpentCents}
                        limitCents={card.monthlyLimitCents}
                        currency={currency}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <HistoryIconButton
                          title={t('fleets.cards.history.open')}
                          onClick={() => {
                            setHistoryCard(card);
                          }}
                        />
                        {canWrite && (
                          <EditIconButton
                            title={t('fleets.cards.editCard')}
                            onClick={() => {
                              setEditCard(card);
                            }}
                          />
                        )}
                        {canDeactivate && card.status !== 'deactivated' && (
                          <RemoveIconButton
                            title={t('fleets.cards.deactivate')}
                            onClick={() => {
                              deactivate.reset();
                              setDeactivateCard(card);
                            }}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </TabPanel>

      {addOpen && (
        <FleetCardAddDialog
          fleetId={fleetId}
          onClose={() => {
            setAddOpen(false);
          }}
        />
      )}
      {editCard != null && (
        <FleetCardEditDialog
          fleetId={fleetId}
          card={editCard}
          onClose={() => {
            setEditCard(null);
          }}
        />
      )}
      {historyCard != null && (
        <FleetCardHistoryDialog
          fleetId={fleetId}
          card={historyCard}
          onClose={() => {
            setHistoryCard(null);
          }}
        />
      )}
      <ConfirmDialog
        open={deactivateCard != null}
        onOpenChange={(open) => {
          if (!open) setDeactivateCard(null);
        }}
        title={t('fleets.cards.deactivateTitle')}
        description={t('fleets.cards.deactivateDescription', {
          value: deactivateCard?.idToken ?? '',
        })}
        confirmLabel={t('fleets.cards.deactivate')}
        isPending={deactivate.isPending}
        onConfirm={() => {
          if (deactivateCard != null) deactivate.mutate(deactivateCard);
          return false;
        }}
      >
        {deactivate.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(deactivate.error, t)}</p>
        )}
      </ConfirmDialog>
      {canWrite && (
        <FleetCardImportDialog fleetId={fleetId} open={importOpen} onOpenChange={setImportOpen} />
      )}
    </>
  );
}

function FleetCardAddDialog({
  fleetId,
  onClose,
}: {
  fleetId: string;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const savedToast = useSavedToast();
  const [idToken, setIdToken] = useState('');
  const [tokenType, setTokenType] = useState<string>('ISO14443');
  const [label, setLabel] = useState('');
  const [member, setMember] = useState<FleetMemberSelection | null>(null);
  const [limit, setLimit] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const currency = useCompanyCurrency().currency ?? '';
  const limitCents = parseMonthlyLimitInput(limit);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/v1/fleets/${fleetId}/cards`, {
        idToken: idToken.trim(),
        tokenType,
        ...(label.trim() !== '' ? { label: label.trim() } : {}),
        ...(member != null ? { driverId: member.id } : {}),
        ...(typeof limitCents === 'number' ? { monthlyLimitCents: limitCents } : {}),
      }),
    onSuccess: () => {
      savedToast();
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'cards'] });
      onClose();
    },
  });

  const errors: Record<string, string> = {};
  if (idToken.trim() === '') errors['idToken'] = t('validation.required');
  if (limitCents === 'invalid') errors['limit'] = t('fleets.cards.monthlyLimit.invalid');

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent scrollable className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('fleets.cards.addCard')}</DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit} noValidate>
          <DialogBody className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-value">{t('fleets.cards.value')}</Label>
              <Input
                id="fleet-card-value"
                value={idToken}
                onChange={(e) => {
                  setIdToken(e.target.value);
                  mutation.reset();
                }}
                className={hasSubmitted && errors['idToken'] ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors['idToken'] && (
                <p className="text-sm text-destructive">{errors['idToken']}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-type">{t('tokens.type')}</Label>
              <Select
                id="fleet-card-type"
                value={tokenType}
                onChange={(e) => {
                  setTokenType(e.target.value);
                }}
              >
                {PORTAL_ID_TOKEN_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-label">{t('tokens.label')}</Label>
              <Input
                id="fleet-card-label"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
                aria-describedby="fleet-card-label-hint"
              />
              <p id="fleet-card-label-hint" className="text-xs text-muted-foreground">
                {t('fleets.cards.labelHint')}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-member">{t('fleets.cards.member')}</Label>
              <FleetMemberCombobox
                id="fleet-card-member"
                fleetId={fleetId}
                value={member}
                onSelect={setMember}
              />
              <p className="text-xs text-muted-foreground">{t('fleets.cards.memberHint')}</p>
            </div>
            <FleetCardMonthlyLimitField
              id="fleet-card-limit"
              value={limit}
              onChange={(value) => {
                setLimit(value);
                mutation.reset();
              }}
              currency={currency}
              error={hasSubmitted ? errors['limit'] : undefined}
            />
          </DialogBody>
          {mutation.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(mutation.error, t)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <CreateButton
              type="submit"
              label={t('fleets.cards.addCard')}
              pending={mutation.isPending}
              disabled={mutation.isPending}
            />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

function FleetCardEditDialog({
  fleetId,
  card,
  onClose,
}: {
  fleetId: string;
  card: FleetCard;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const savedToast = useSavedToast();
  const isFleetUser = useIsFleetUser();
  const lock = fleetCardActiveLock(card, isFleetUser);
  const [label, setLabel] = useState(card.label ?? '');
  const [member, setMember] = useState<FleetMemberSelection | null>(cardMember(card));
  const [isActive, setIsActive] = useState(card.isActive);
  const [limit, setLimit] = useState(monthlyLimitInput(card.monthlyLimitCents));
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const currency = useCompanyCurrency().currency ?? '';
  const limitCents = parseMonthlyLimitInput(limit);
  const limitError = limitCents === 'invalid' ? t('fleets.cards.monthlyLimit.invalid') : undefined;

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch(`/v1/fleets/${fleetId}/cards/${card.id}`, body),
    onSuccess: () => {
      savedToast();
      void queryClient.invalidateQueries({ queryKey: ['fleets', fleetId, 'cards'] });
      onClose();
    },
  });

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (limitCents === 'invalid') return;
    const body: Record<string, unknown> = {};
    if (limitCents !== card.monthlyLimitCents) body['monthlyLimitCents'] = limitCents;
    const nextLabel = label.trim() === '' ? null : label.trim();
    if (nextLabel !== card.label) body['label'] = nextLabel;
    const nextDriver = member?.id ?? null;
    if (nextDriver !== (card.driver?.id ?? null)) body['driverId'] = nextDriver;
    if (lock == null && isActive !== card.isActive) body['isActive'] = isActive;
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    mutation.mutate(body);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent scrollable className="max-w-[95vw] md:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('fleets.cards.editCard')}</DialogTitle>
        </DialogHeader>
        <DialogForm onSubmit={handleSubmit} noValidate>
          <DialogBody className="grid gap-4">
            <p className="text-sm">
              <span className="text-muted-foreground">{t('fleets.cards.value')}: </span>
              <span className="font-medium wrap-anywhere">{card.idToken}</span>
            </p>
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-edit-label">{t('tokens.label')}</Label>
              <Input
                id="fleet-card-edit-label"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  mutation.reset();
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="fleet-card-edit-member">{t('fleets.cards.member')}</Label>
              <FleetMemberCombobox
                id="fleet-card-edit-member"
                fleetId={fleetId}
                value={member}
                onSelect={(value) => {
                  setMember(value);
                  mutation.reset();
                }}
              />
            </div>
            <div className="grid gap-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="fleet-card-edit-active"
                  checked={isActive}
                  disabled={lock != null}
                  aria-describedby="fleet-card-edit-active-hint"
                  onChange={(e) => {
                    setIsActive(e.target.checked);
                    mutation.reset();
                  }}
                />
                <Label htmlFor="fleet-card-edit-active">{t('fleets.cards.active')}</Label>
              </div>
              <p id="fleet-card-edit-active-hint" className="text-xs text-muted-foreground">
                {lock === 'deactivated'
                  ? t('fleets.cards.lockedDeactivated')
                  : lock === 'blockedByOperator'
                    ? t('fleets.cards.lockedByOperator')
                    : t('fleets.cards.activeHint')}
              </p>
            </div>
            <FleetCardMonthlyLimitField
              id="fleet-card-edit-limit"
              value={limit}
              onChange={(value) => {
                setLimit(value);
                mutation.reset();
              }}
              currency={currency}
              error={hasSubmitted ? limitError : undefined}
            />
            <p className="text-sm">
              <span className="text-muted-foreground">
                {t('fleets.cards.monthlyLimit.thisMonth')}:{' '}
              </span>
              <FleetCardMonthSpend
                spentCents={card.monthSpentCents}
                limitCents={card.monthlyLimitCents}
                currency={currency}
              />
            </p>
          </DialogBody>
          {mutation.isError && (
            <p className="text-sm text-destructive">{getErrorMessage(mutation.error, t)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <SaveButton isPending={mutation.isPending} />
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
