// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Copy, Key, Trash2, AlertTriangle, Check, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { API_BASE_URL } from '@/lib/config';
import { useAuth } from '@/lib/auth';
import { useToast } from '@/components/ui/toast';
import { PermissionEditor } from '@/components/PermissionEditor';

const CODE_TABS = ['cURL', 'JavaScript', 'Python'] as const;
type CodeTab = (typeof CODE_TABS)[number];

interface ApiKey {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  permissions: string[] | null;
  tokenSuffix: string | null;
}

interface CreateApiKeyResponse {
  id: string;
  name: string;
  rawToken: string;
  expiresAt: string | null;
  createdAt: string;
}

const EXPIRY_OPTIONS = [
  { value: '0', labelKey: 'settings.apiKeyNoExpiry' },
  { value: '30', labelKey: 'settings.apiKeyDays', days: 30 },
  { value: '60', labelKey: 'settings.apiKeyDays', days: 60 },
  { value: '90', labelKey: 'settings.apiKeyDays', days: 90 },
  { value: '180', labelKey: 'settings.apiKeyDays', days: 180 },
  { value: '365', labelKey: 'settings.apiKeyDays', days: 365 },
  { value: 'custom', labelKey: 'settings.apiKeyCustomDays' },
] as const;

export function ApiKeysSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userPermissions = useAuth((s) => s.permissions);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiryOption, setExpiryOption] = useState('0');
  const [customDays, setCustomDays] = useState('');

  // Permission picker state for create dialog
  const [selectedKeyPerms, setSelectedKeyPerms] = useState<string[]>([]);

  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState('');

  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [editKey, setEditKey] = useState<ApiKey | null>(null);
  const [editPerms, setEditPerms] = useState<string[]>([]);
  const [codeTab, setCodeTab] = useState<CodeTab>('cURL');
  const [codeCopied, setCodeCopied] = useState(false);

  const { data: keys = [] } = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<ApiKey[]>('/v1/api-keys'),
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; expiresInDays: number | null; permissions: string[] }) =>
      api.post<CreateApiKeyResponse>('/v1/api-keys', body),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setCreateOpen(false);
      setName('');
      setExpiryOption('0');
      setCustomDays('');
      setCreatedToken(data.rawToken);
      setTokenDialogOpen(true);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.delete<{ success: boolean }>(`/v1/api-keys/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      toast({ title: t('settings.apiKeyRevoked'), variant: 'success' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: string[] }) =>
      api.patch<{ success: boolean }>(`/v1/api-keys/${id}`, { permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      setEditKey(null);
      toast({ title: t('settings.apiKeyUpdated'), variant: 'success' });
    },
  });

  function handleOpenCreate(): void {
    // Default: all user permissions selected
    setSelectedKeyPerms([...userPermissions]);
    setCreateOpen(true);
  }

  function handleCreate(): void {
    let expiresInDays: number | null = null;
    if (expiryOption === 'custom') {
      const parsed = parseInt(customDays, 10);
      if (Number.isNaN(parsed) || parsed < 1) return;
      expiresInDays = parsed;
    } else if (expiryOption !== '0') {
      expiresInDays = parseInt(expiryOption, 10);
    }

    if (selectedKeyPerms.length === 0) return;

    createMutation.mutate({
      name: name.trim(),
      expiresInDays,
      permissions: selectedKeyPerms,
    });
  }

  function handleCopy(): void {
    void navigator.clipboard.writeText(createdToken).then(() => {
      toast({ title: t('settings.apiKeyCopied'), variant: 'success' });
    });
  }

  function isExpired(expiresAt: string | null): boolean {
    if (expiresAt == null) return false;
    return new Date(expiresAt) < new Date();
  }

  const apiUrl = API_BASE_URL || window.location.origin;

  function getCodeExample(tab: CodeTab): string {
    switch (tab) {
      case 'cURL':
        return `curl -X GET "${apiUrl}/v1/stations" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json"`;
      case 'JavaScript':
        return `const response = await fetch("${apiUrl}/v1/stations", {
  headers: {
    "Authorization": "Bearer YOUR_API_KEY",
    "Content-Type": "application/json",
  },
});

const data = await response.json();
console.log(data);`;
      case 'Python':
        return `import requests

response = requests.get(
    "${apiUrl}/v1/stations",
    headers={
        "Authorization": "Bearer YOUR_API_KEY",
        "Content-Type": "application/json",
    },
)

data = response.json()
print(data)`;
    }
  }

  function handleCopyCode(): void {
    void navigator.clipboard.writeText(getCodeExample(codeTab)).then(() => {
      setCodeCopied(true);
      setTimeout(() => {
        setCodeCopied(false);
      }, 2000);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{t('settings.apiKeys')}</CardTitle>
            <Button size="sm" onClick={handleOpenCreate}>
              <Plus className="h-4 w-4" />
              {t('settings.createApiKey')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('settings.apiKeysDescription')}</p>

          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Key className="h-12 w-12 mb-4" />
              <p className="text-sm">{t('settings.noApiKeys')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('settings.apiKeyNameColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyKeyColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyCreatedColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyLastUsedColumn')}</TableHead>
                    <TableHead>{t('settings.apiKeyExpiresColumn')}</TableHead>
                    <TableHead className="text-right">{t('common.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((key) => (
                    <TableRow key={key.id}>
                      <TableCell className="font-medium">{key.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {key.tokenSuffix != null ? `...${key.tokenSuffix}` : '--'}
                      </TableCell>
                      <TableCell>{new Date(key.createdAt).toLocaleDateString()}</TableCell>
                      <TableCell>
                        {key.lastUsedAt != null
                          ? new Date(key.lastUsedAt).toLocaleDateString()
                          : t('settings.apiKeyNeverUsed')}
                      </TableCell>
                      <TableCell>
                        {key.expiresAt == null ? (
                          t('settings.apiKeyNever')
                        ) : isExpired(key.expiresAt) ? (
                          <Badge variant="destructive">{t('settings.apiKeyExpired')}</Badge>
                        ) : (
                          new Date(key.expiresAt).toLocaleDateString()
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('settings.apiKeyEditPermissions')}
                          onClick={() => {
                            setEditKey(key);
                            setEditPerms(
                              Array.isArray(key.permissions)
                                ? [...key.permissions]
                                : [...userPermissions],
                            );
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('settings.apiKeyRevoke')}
                          onClick={() => {
                            setRevokeId(key.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>

        {/* Create Key Dialog */}
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.createApiKey')}</DialogTitle>
            </DialogHeader>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                handleCreate();
              }}
            >
              <div className="grid gap-2">
                <Label htmlFor="api-key-name">{t('settings.apiKeyName')}</Label>
                <Input
                  id="api-key-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                  }}
                  placeholder={t('settings.apiKeyNamePlaceholder')}
                  maxLength={255}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="api-key-expiry-select">{t('settings.apiKeyExpiry')}</Label>
                <Select
                  id="api-key-expiry-select"
                  value={expiryOption}
                  onChange={(e) => {
                    setExpiryOption(e.target.value);
                  }}
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.value === '0' || opt.value === 'custom'
                        ? t(opt.labelKey)
                        : t(opt.labelKey, { count: opt.days })}
                    </option>
                  ))}
                </Select>
              </div>
              {expiryOption === 'custom' && (
                <div className="grid gap-2">
                  <Label htmlFor="api-key-custom-days">{t('settings.apiKeyCustomDays')}</Label>
                  <Input
                    id="api-key-custom-days"
                    type="number"
                    min={1}
                    value={customDays}
                    onChange={(e) => {
                      setCustomDays(e.target.value);
                    }}
                    required
                  />
                </div>
              )}
              {userPermissions.length > 0 && (
                <div className="grid gap-2">
                  <Label>{t('settings.apiKeyPermissions')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.apiKeyPermissionsDescription')}
                  </p>
                  <PermissionEditor
                    value={selectedKeyPerms}
                    onChange={setSelectedKeyPerms}
                    columns={1}
                    maxHeight="14rem"
                  />
                  {selectedKeyPerms.length === 0 && (
                    <p className="text-sm text-destructive">{t('settings.apiKeyNoPermissions')}</p>
                  )}
                </div>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => {
                    setCreateOpen(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  disabled={
                    createMutation.isPending || name.trim() === '' || selectedKeyPerms.length === 0
                  }
                >
                  {t('settings.createApiKey')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Show Token Dialog */}
        <Dialog
          open={tokenDialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setCreatedToken('');
            }
            setTokenDialogOpen(open);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.apiKeyCreated')}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4">
              <div className="flex items-center gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                <span>{t('settings.apiKeyCreatedDescription')}</span>
              </div>
              <div className="flex gap-2">
                <Input value={createdToken} readOnly className="flex-1" />
                <Button variant="outline" size="icon" aria-label="Copy" onClick={handleCopy}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setTokenDialogOpen(false);
                  setCreatedToken('');
                }}
              >
                {t('common.done')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Revoke Confirm Dialog */}
        <ConfirmDialog
          open={revokeId != null}
          onOpenChange={(open) => {
            if (!open) setRevokeId(null);
          }}
          title={t('settings.apiKeyRevoke')}
          description={t('settings.apiKeyRevokeConfirm')}
          confirmLabel={t('settings.apiKeyRevoke')}
          variant="destructive"
          isPending={revokeMutation.isPending}
          onConfirm={() => {
            if (revokeId != null) {
              revokeMutation.mutate(revokeId);
            }
          }}
        />

        {/* Edit Permissions Dialog */}
        <Dialog
          open={editKey != null}
          onOpenChange={(open) => {
            if (!open) setEditKey(null);
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.apiKeyEditPermissions')}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4">
              <p className="text-sm text-muted-foreground">{editKey?.name}</p>
              <PermissionEditor
                value={editPerms}
                onChange={setEditPerms}
                columns={1}
                maxHeight="14rem"
              />
              {editPerms.length === 0 && (
                <p className="text-sm text-destructive">{t('settings.apiKeyNoPermissions')}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setEditKey(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                disabled={updateMutation.isPending || editPerms.length === 0}
                onClick={() => {
                  if (editKey != null) {
                    updateMutation.mutate({
                      id: editKey.id,
                      permissions: editPerms,
                    });
                  }
                }}
              >
                {t('common.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>

      {/* Quick Start Code Examples */}
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.apiKeyQuickStart')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('settings.apiKeyQuickStartDescription')}
          </p>
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between border-b border-border bg-muted/50 px-1">
              <div className="flex">
                {CODE_TABS.map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`px-3 py-2 text-sm font-medium transition-colors ${
                      codeTab === tab
                        ? 'text-primary border-b-2 border-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => {
                      setCodeTab(tab);
                    }}
                  >
                    {tab}
                  </button>
                ))}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 mr-1"
                aria-label="Copy code"
                onClick={handleCopyCode}
              >
                {codeCopied ? (
                  <Check className="h-4 w-4 text-success" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <pre className="p-4 text-sm overflow-x-auto bg-muted/30">
              <code>{getCodeExample(codeTab)}</code>
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
