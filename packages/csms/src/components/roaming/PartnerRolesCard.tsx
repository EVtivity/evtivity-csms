// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SaveButton } from '@/components/save-button';
import { useToast } from '@/components/ui/toast';
import { getErrorMessage } from '@/lib/error-message';
import { api } from '@/lib/api';
import { OCPI_ROLE_NAMES, roleNamesOf } from '@evtivity/lib/ocpi-roles';

interface PartnerRolesCardProps {
  partnerId: string;
  /** The roles the partner declared in its credentials. */
  declaredRoles: unknown;
  /** The roles the operator approved; the OCPI server acts on these only. */
  approvedRoles: string[];
  /** When the approved roles were decided; null until the first handshake or an operator save. */
  rolesApprovedAt: string | null;
  canWrite: boolean;
}

/**
 * The OCPI roles the CSMS acts on for a partner, approved by the operator
 * (`approvedRoles` on `PATCH /v1/ocpi/partners/:id`). A role the partner
 * declares is used only after it is approved here.
 */
export function PartnerRolesCard({
  partnerId,
  declaredRoles,
  approvedRoles,
  rolesApprovedAt,
  canWrite,
}: PartnerRolesCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const approvedKey = [...approvedRoles].sort().join(',');
  const [selected, setSelected] = useState<string[]>(approvedRoles);

  // A save or another user's change reloads the partner: start from it again.
  useEffect(() => {
    setSelected(approvedKey === '' ? [] : approvedKey.split(','));
  }, [approvedKey]);

  const declared = roleNamesOf(declaredRoles);
  const held = declared.filter((r) => !approvedRoles.includes(r));
  const changed = [...selected].sort().join(',') !== approvedKey;

  const saveMutation = useMutation({
    mutationFn: (roles: string[]) =>
      api.patch(`/v1/ocpi/partners/${partnerId}`, { approvedRoles: roles }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ocpi-partners'] });
      toast({ title: t('roaming.partners.approvedRolesSaved') });
    },
    onError: (err) => {
      toast({ variant: 'destructive', title: getErrorMessage(err, t) });
    },
  });

  function toggle(role: string, checked: boolean): void {
    setSelected((current) =>
      checked ? [...new Set([...current, role])] : current.filter((r) => r !== role),
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('roaming.partners.approvedRoles')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('roaming.partners.approvedRolesHint')}</p>
        {rolesApprovedAt == null && (
          <p className="text-sm">{t('roaming.partners.rolesNotDecided')}</p>
        )}
        <p className="text-sm">
          {declared.length === 0
            ? t('roaming.partners.noDeclaredRoles')
            : t('roaming.partners.declaredRoles', { roles: declared.join(', ') })}
        </p>
        {held.length > 0 && (
          <p className="text-sm text-warning" role="status">
            {t('roaming.partners.heldRoles', { roles: held.join(', ') })}
          </p>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {OCPI_ROLE_NAMES.map((role) => {
            const id = `partner-approved-role-${role}`;
            return (
              <div key={role} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={selected.includes(role)}
                  disabled={!canWrite || saveMutation.isPending}
                  onChange={(e) => {
                    toggle(role, e.target.checked);
                  }}
                />
                <Label htmlFor={id}>{role}</Label>
              </div>
            );
          })}
        </div>
        {canWrite && (
          <div className="flex justify-end">
            <SaveButton
              type="button"
              isPending={saveMutation.isPending}
              disabled={!changed || saveMutation.isPending}
              onClick={() => {
                saveMutation.mutate(OCPI_ROLE_NAMES.filter((r) => selected.includes(r)));
              }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
