// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

interface PermissionGroup {
  label: string;
  permissions: string[];
}

interface PermissionEditorProps {
  value: string[];
  onChange: (perms: string[]) => void;
  disabled?: boolean;
  columns?: 1 | 2;
  maxHeight?: string;
}

export function PermissionEditor({
  value,
  onChange,
  disabled = false,
  columns = 2,
  maxHeight,
}: PermissionEditorProps): React.JSX.Element {
  const { t } = useTranslation();

  const { data: groups = [] } = useQuery({
    queryKey: ['permission-groups'],
    queryFn: () => api.get<PermissionGroup[]>('/v1/permissions'),
  });

  const valueSet = new Set(value);

  function handleToggle(perm: string, checked: boolean): void {
    const next = new Set(valueSet);

    if (checked) {
      next.add(perm);
      // Selecting write auto-selects read
      if (perm.endsWith(':write')) {
        const readVersion = perm.replace(':write', ':read');
        next.add(readVersion);
      }
    } else {
      next.delete(perm);
      // Deselecting read auto-deselects write
      if (perm.endsWith(':read')) {
        const writeVersion = perm.replace(':read', ':write');
        next.delete(writeVersion);
      }
    }

    onChange([...next]);
  }

  // Separate page-level and settings groups
  const pageGroups = groups.filter((g) => !g.label.startsWith('Settings'));
  const settingsGroups = groups.filter((g) => g.label.startsWith('Settings'));

  const gridClass =
    columns === 1 ? 'grid grid-cols-1 gap-2' : 'grid grid-cols-1 md:grid-cols-2 gap-2';

  return (
    <div
      className="space-y-4"
      style={maxHeight != null ? { maxHeight, overflowY: 'auto' } : undefined}
    >
      {pageGroups.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('users.pagePermissions')}</p>
          <div className={gridClass}>
            {pageGroups.map((group) => (
              <PermissionGroupRow
                key={group.label}
                group={group}
                valueSet={valueSet}
                onToggle={handleToggle}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      )}

      {settingsGroups.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('users.settingsPermissions')}</p>
          <div className={gridClass}>
            {settingsGroups.map((group) => (
              <PermissionGroupRow
                key={group.label}
                group={group}
                valueSet={valueSet}
                onToggle={handleToggle}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PermissionGroupRow({
  group,
  valueSet,
  onToggle,
  disabled,
}: {
  group: PermissionGroup;
  valueSet: Set<string>;
  onToggle: (perm: string, checked: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  const readPerm = group.permissions.find((p) => p.endsWith(':read'));
  const writePerm = group.permissions.find((p) => p.endsWith(':write'));

  return (
    <div className="flex items-center gap-4 rounded-md border border-border p-2">
      <span className="text-sm font-medium min-w-28">{group.label}</span>
      <div className="flex items-center gap-4 ml-auto">
        {readPerm != null && (
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id={`perm-${readPerm}`}
              checked={valueSet.has(readPerm)}
              onChange={(e) => {
                onToggle(readPerm, e.target.checked);
              }}
              disabled={disabled || (writePerm != null && valueSet.has(writePerm))}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor={`perm-${readPerm}`} className="text-xs">
              Read
            </Label>
          </div>
        )}
        {writePerm != null && (
          <div className="flex items-center gap-1.5">
            <input
              type="checkbox"
              id={`perm-${writePerm}`}
              checked={valueSet.has(writePerm)}
              onChange={(e) => {
                onToggle(writePerm, e.target.checked);
              }}
              disabled={disabled}
              className="h-4 w-4 rounded border-input"
            />
            <Label htmlFor={`perm-${writePerm}`} className="text-xs">
              Write
            </Label>
          </div>
        )}
      </div>
    </div>
  );
}
