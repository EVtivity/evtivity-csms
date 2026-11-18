// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FLEET_MANAGER_ROLE_NAME, accessScopeForRole } from '@evtivity/lib/user-access-scope';
import { Checkbox } from '@/components/ui/checkbox';
import { FleetCombobox } from '@/components/fleet-combobox';
import { RemoveIconButton } from '@/components/remove-icon-button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** What a user reaches: every site, some sites, or some fleets (a fleet user). */
export type UserAccessKind = 'all' | 'sites' | 'fleets';

export function userAccessKindOf(user: {
  accessScope?: 'sites' | 'fleets' | undefined;
  hasAllSiteAccess: boolean;
}): UserAccessKind {
  if (user.accessScope === 'fleets') return 'fleets';
  return user.hasAllSiteAccess ? 'all' : 'sites';
}

/** The access fields of a user create or update body. */
export function userAccessBody(
  kind: UserAccessKind,
  siteIds: string[],
  fleetIds: string[],
): {
  accessScope: 'sites' | 'fleets';
  hasAllSiteAccess?: boolean;
  siteIds?: string[];
  fleetIds?: string[];
} {
  if (kind === 'fleets') return { accessScope: 'fleets', fleetIds };
  return {
    accessScope: 'sites',
    hasAllSiteAccess: kind === 'all',
    siteIds: kind === 'all' ? [] : siteIds,
  };
}

/**
 * The access a user takes when its role is picked: Fleets for the Fleet
 * Manager role; for another role the site access it had (All Sites or Sites),
 * else Sites, the default of a new user.
 */
export function accessKindForRole(roleName: string, current: UserAccessKind): UserAccessKind {
  if (accessScopeForRole(roleName) === 'fleets') return 'fleets';
  return current === 'fleets' ? 'sites' : current;
}

/**
 * The roles a user form offers: the Fleet Manager role only where fleet users
 * can be made (an assignable role, the Fleets feature on and an actor with
 * access to every site), or when the user already holds it.
 */
export function offeredRoles<R extends { id: string; name: string; assignable?: boolean }>(
  roles: readonly R[],
  canOfferFleets: boolean,
  currentRoleId?: string,
): R[] {
  return roles.filter(
    (r) =>
      r.id === currentRoleId ||
      r.name !== FLEET_MANAGER_ROLE_NAME ||
      (canOfferFleets && r.assignable !== false),
  );
}

interface NamedItem {
  id: string;
  name: string;
}

interface UserAccessFieldProps {
  idPrefix: string;
  kind: UserAccessKind;
  onKindChange: (kind: UserAccessKind) => void;
  siteIds: string[];
  onSiteIdsChange: (ids: string[]) => void;
  fleetIds: string[];
  onFleetIdsChange: (ids: string[]) => void;
  /** The actor has access to every site: it may grant every site. */
  canGrantAllSites: boolean;
  /**
   * The name of the role picked, which decides the access: Fleets for the
   * Fleet Manager role, All Sites or Sites for every other role. Undefined
   * while no role is picked: the field waits for one.
   */
  roleName: string | undefined;
  /** A message under the list (a required site), shown after a submit. */
  error?: string | undefined;
}

/**
 * The Access field of the user forms. The role decides the access: the Fleet
 * Manager role takes Fleets only (with the fleet list), every other role All
 * Sites or Sites (with the site list).
 */
export function UserAccessField({
  idPrefix,
  kind,
  onKindChange,
  siteIds,
  onSiteIdsChange,
  fleetIds,
  onFleetIdsChange,
  canGrantAllSites,
  roleName,
  error,
}: UserAccessFieldProps): React.JSX.Element {
  const { t } = useTranslation();
  const noRole = roleName == null;
  const fleetsRole = roleName != null && accessScopeForRole(roleName) === 'fleets';

  const { data: sitesData } = useQuery({
    queryKey: ['sites-for-select'],
    queryFn: () => api.get<{ data: NamedItem[] }>('/v1/sites?limit=100'),
    enabled: !noRole && kind === 'sites',
  });
  const items = sitesData?.data ?? [];
  const helpText = noRole
    ? t('users.access.pickRoleFirst')
    : fleetsRole
      ? `${t('users.access.fleetsDescription')} ${t('users.access.fleetManagerFleetsOnly')}`
      : t(kind === 'all' ? 'users.allSitesDescription' : 'users.access.sitesDescription');

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-access`} className="leading-6">
        {t('users.access.label')}
      </Label>
      <Select
        id={`${idPrefix}-access`}
        value={noRole ? '' : kind}
        disabled={noRole || fleetsRole}
        aria-describedby={`${idPrefix}-access-help`}
        onChange={(e) => {
          onKindChange(e.target.value as UserAccessKind);
        }}
      >
        {noRole && <option value="">{t('users.access.noRoleYet')}</option>}
        {fleetsRole && <option value="fleets">{t('users.access.fleets')}</option>}
        {!noRole && !fleetsRole && (canGrantAllSites || kind === 'all') && (
          <option value="all">{t('users.allSites')}</option>
        )}
        {!noRole && !fleetsRole && <option value="sites">{t('users.access.sites')}</option>}
      </Select>
      <p id={`${idPrefix}-access-help`} className="text-xs text-muted-foreground">
        {helpText}
      </p>
      {!noRole && kind === 'sites' && (
        <div
          className={cn(
            'max-h-48 space-y-2 overflow-y-auto rounded-md border p-3',
            error != null ? 'border-destructive' : 'border-border',
          )}
          data-testid={`${idPrefix}-sites-list`}
        >
          {items.length === 0 && <p className="text-xs text-muted-foreground">n/a</p>}
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-sites-${item.id}`}
                checked={siteIds.includes(item.id)}
                onChange={(e) => {
                  onSiteIdsChange(
                    e.target.checked
                      ? [...siteIds, item.id]
                      : siteIds.filter((id) => id !== item.id),
                  );
                }}
              />
              <Label htmlFor={`${idPrefix}-sites-${item.id}`}>{item.name}</Label>
            </div>
          ))}
        </div>
      )}
      {fleetsRole && (
        <FleetPicks
          idPrefix={idPrefix}
          fleetIds={fleetIds}
          onFleetIdsChange={onFleetIdsChange}
          invalid={error != null}
        />
      )}
      {error != null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The fleets a fleet user reaches: the picked fleets, each with a remove
 * button, and a search to add another. Fleets are searched, so every fleet
 * can be picked, not only a first page.
 */
function FleetPicks({
  idPrefix,
  fleetIds,
  onFleetIdsChange,
  invalid,
}: {
  idPrefix: string;
  fleetIds: string[];
  onFleetIdsChange: (ids: string[]) => void;
  invalid: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Names of fleets picked in this form; fleets the user already had are read by id.
  const [pickedNames, setPickedNames] = useState<Record<string, string>>({});
  const unknown = fleetIds.filter((id) => pickedNames[id] == null);
  const lookups = useQueries({
    queries: unknown.map((id) => ({
      queryKey: ['fleets', id],
      queryFn: () => api.get<NamedItem>(`/v1/fleets/${id}`),
    })),
  });
  const nameOf = (id: string): string => {
    const picked = pickedNames[id];
    if (picked != null) return picked;
    const found = lookups[unknown.indexOf(id)]?.data;
    return found?.name ?? t('users.access.unknownFleet');
  };

  return (
    <div
      className={cn(
        'space-y-2 rounded-md border p-3',
        invalid ? 'border-destructive' : 'border-border',
      )}
      data-testid={`${idPrefix}-fleets-list`}
    >
      {fleetIds.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('users.access.noFleetsPicked')}</p>
      ) : (
        <ul className="space-y-1">
          {fleetIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm">{nameOf(id)}</span>
              <RemoveIconButton
                title={t('users.access.removeFleet', { name: nameOf(id) })}
                onClick={() => {
                  onFleetIdsChange(fleetIds.filter((f) => f !== id));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <FleetCombobox
        id={`${idPrefix}-fleet-search`}
        value={null}
        excludeIds={fleetIds}
        onSelect={(fleet) => {
          if (fleet == null || fleetIds.includes(fleet.id)) return;
          setPickedNames((names) => ({ ...names, [fleet.id]: fleet.name }));
          onFleetIdsChange([...fleetIds, fleet.id]);
        }}
      />
    </div>
  );
}
