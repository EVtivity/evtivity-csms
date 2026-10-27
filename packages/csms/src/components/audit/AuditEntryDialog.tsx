// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DescriptionItem, DescriptionList } from '@/components/ui/description-list';
import { IdText } from '@/components/ui/id-text';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CodeBlock } from '@/components/ai/CodeBlock';
import { actorDisplay, AuditActorBadge, type AuditEntry } from '@/components/EntityHistoryTab';
import { auditActionLabel, auditEntityLabel } from '@/lib/audit-labels';
import { auditEntityRoute } from '@/lib/audit-entity-routes';
import { auditFieldChanges, auditFieldLabel, isRedactedValue } from '@/lib/audit-diff';
import { useHasPermission } from '@/lib/auth';
import { formatDateTime, useUserTimezone } from '@/lib/timezone';

interface AuditEntryDialogProps {
  entry: AuditEntry | null;
  onOpenChange: (open: boolean) => void;
}

function formatTimestamp(iso: string, timezone: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d, timezone);
}

function FieldValue({ value }: { value: unknown }): React.JSX.Element {
  const { t } = useTranslation();
  if (value == null) return <span className="text-muted-foreground">--</span>;
  if (isRedactedValue(value)) {
    return <span className="italic text-muted-foreground">{t('audit.redacted')}</span>;
  }
  if (typeof value === 'string') return <span className="wrap-anywhere">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span>{String(value)}</span>;
  }
  return (
    <div className="w-0 min-w-full" data-testid="json-detail">
      <CodeBlock code={JSON.stringify(value, null, 2)} language="JSON" bounded />
    </div>
  );
}

/** One audit row in full: who, what, when, and a Field / Before / After table of its changes. */
export function AuditEntryDialog({
  entry,
  onOpenChange,
}: AuditEntryDialogProps): React.JSX.Element | null {
  if (entry == null) return null;
  return <AuditEntryDialogBody entry={entry} onOpenChange={onOpenChange} />;
}

function AuditEntryDialogBody({
  entry,
  onOpenChange,
}: {
  entry: AuditEntry;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const timezone = useUserTimezone();
  const navigate = useNavigate();
  const [showUnchanged, setShowUnchanged] = useState(false);
  const route = auditEntityRoute(entry.entityType);
  // A typed Permission of AUDIT_ENTITY_ROUTES; audit:read (held here) without a route.
  const permission = route?.permission ?? 'audit:read';
  const canOpenEntity = useHasPermission(permission);

  const changes = useMemo(
    () => auditFieldChanges(entry.before, entry.after),
    [entry.before, entry.after],
  );
  const hasBefore = entry.before != null;
  const hasAfter = entry.after != null;
  const changedCount = changes.filter((c) => c.changed).length;
  const visible =
    showUnchanged || !hasBefore || !hasAfter ? changes : changes.filter((c) => c.changed);
  const unchangedCount = changes.length - changedCount;
  const deleted = entry.entityId == null;
  const entityId = entry.entityId ?? entry.entityIdSnapshot;
  const showGoTo = route != null && !deleted && canOpenEntity;
  const title = t('audit.entryTitle', {
    action: auditActionLabel(t, entry.action),
    entity: auditEntityLabel(t, entry.entityType),
  });

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{formatTimestamp(entry.createdAt, timezone)}</DialogDescription>
        </DialogHeader>

        <DescriptionList>
          <DescriptionItem label={t('audit.action')}>
            <Badge variant="outline" title={entry.action}>
              {auditActionLabel(t, entry.action)}
            </Badge>
          </DescriptionItem>
          <DescriptionItem label={t('audit.entityType')}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="secondary" title={entry.entityType}>
                {auditEntityLabel(t, entry.entityType)}
              </Badge>
              {deleted && (
                <span className="text-xs text-muted-foreground" data-testid="audit-entity-deleted">
                  {t('audit.entityDeleted')}
                </span>
              )}
            </span>
          </DescriptionItem>
          <DescriptionItem label={t('audit.entityId')}>
            <IdText value={entityId} />
          </DescriptionItem>
          <DescriptionItem label={t('audit.actor')}>
            <span className="flex min-w-0 flex-wrap items-center gap-2">
              <AuditActorBadge actor={entry.actor} />
              <span>{actorDisplay(entry)}</span>
            </span>
          </DescriptionItem>
          {entry.viaAi != null && (
            <DescriptionItem label={t('audit.viaAi')}>
              <span data-testid="audit-via-ai">
                {t(`audit.viaAiChannels.${entry.viaAi.channel}`, {
                  defaultValue: entry.viaAi.channel,
                })}
                {entry.viaAi.conversationId != null ? ` (${entry.viaAi.conversationId})` : ''}
              </span>
            </DescriptionItem>
          )}
          {entry.notes != null && entry.notes !== '' && (
            <DescriptionItem label={t('audit.notes')}>{entry.notes}</DescriptionItem>
          )}
        </DescriptionList>

        <div className="min-w-0 space-y-2" data-testid="audit-changes">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('audit.changes')}</h3>
            {hasBefore && hasAfter && unchangedCount > 0 && (
              <Button
                type="button"
                variant="link"
                size="inline"
                onClick={() => {
                  setShowUnchanged((v) => !v);
                }}
              >
                {showUnchanged ? t('audit.hideUnchanged') : t('audit.showUnchanged')}
              </Button>
            )}
          </div>
          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="audit-no-changes">
              {t('audit.noChanges')}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('audit.field')}</TableHead>
                    {hasBefore && <TableHead>{t('audit.before')}</TableHead>}
                    {hasAfter && <TableHead>{t('audit.after')}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((change) => (
                    <TableRow key={change.key} data-testid={`audit-field-${change.key}`}>
                      <TableCell
                        className="align-top text-sm font-medium whitespace-normal wrap-anywhere"
                        title={change.key}
                      >
                        {auditFieldLabel(t, change.key)}
                      </TableCell>
                      {hasBefore && (
                        <TableCell className="min-w-0 align-top text-sm whitespace-normal wrap-anywhere">
                          <FieldValue value={change.before} />
                        </TableCell>
                      )}
                      {hasAfter && (
                        <TableCell className="min-w-0 align-top text-sm whitespace-normal wrap-anywhere">
                          <FieldValue value={change.after} />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.close')}
          </Button>
          {showGoTo && (
            <Button
              type="button"
              onClick={() => {
                onOpenChange(false);
                void navigate(route.path(entry.entityId ?? ''));
              }}
            >
              {t('audit.goToEntity')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
