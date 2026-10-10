// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTab } from '@/hooks/use-tab';
import { BackButton } from '@/components/back-button';
import { EntityNavButtons } from '@/components/entity-nav-buttons';
import { CopyableId } from '@/components/copyable-id';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EntityHistoryTab } from '@/components/EntityHistoryTab';
import { UserDetailsTab } from '@/components/user/UserDetailsTab';
import type { UserDetailUser, UserRole } from '@/components/user/UserDetailsTab';
import { UserPermissionsTab } from '@/components/user/UserPermissionsTab';
import { UserSecurityTab } from '@/components/user/UserSecurityTab';
import { api } from '@/lib/api';
import { isSubsetOf } from '@evtivity/lib/permissions';
import { useAuth } from '@/lib/auth';
import { LoadingLogo } from '@/components/loading-logo';

export function UserDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUserId = useAuth((s) => s.user?.id);
  const ownPermissions = useAuth((s) => s.permissions);
  const [activeTab, setActiveTab] = useTab('details');

  const isOwnUser = id === currentUserId;

  // Redirect to profile page when viewing own user
  useEffect(() => {
    if (isOwnUser) {
      void navigate('/profile', { replace: true });
    }
  }, [isOwnUser, navigate]);

  const { data: user, isLoading } = useQuery({
    queryKey: ['users', id],
    queryFn: () => api.get<UserDetailUser>(`/v1/users/${id ?? ''}`),
    enabled: id != null,
  });

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<UserRole[]>('/v1/roles'),
  });

  if (isLoading) {
    return <LoadingLogo />;
  }

  if (user == null) {
    return <p className="text-destructive">{t('users.userNotFound')}</p>;
  }

  // Account changes (password, invite, email, status, role, permissions, site
  // access, phone) need every permission of the user: the API answers 404
  // otherwise.
  const canAdminister = isSubsetOf(user.permissions ?? [], ownPermissions);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <BackButton to="/users" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold wrap-anywhere">{user.email}</h1>
          <CopyableId id={user.id} />
        </div>
        <Badge variant={user.isActive ? 'default' : 'outline'}>
          {user.isActive ? t('common.active') : t('common.inactive')}
        </Badge>
        <EntityNavButtons resource="users" basePath="/users" currentId={id} />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="details">{t('common.details')}</TabsTrigger>
          <TabsTrigger value="permissions">{t('users.permissions')}</TabsTrigger>
          {canAdminister && <TabsTrigger value="security">{t('users.resetPassword')}</TabsTrigger>}
          <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <UserDetailsTab
            user={user}
            userId={user.id}
            roles={roles}
            canAdminister={canAdminister}
          />
        </TabsContent>

        <TabsContent value="permissions">
          <UserPermissionsTab userId={user.id} canEdit={canAdminister} />
        </TabsContent>

        {canAdminister && (
          <TabsContent value="security">
            <UserSecurityTab userId={user.id} />
          </TabsContent>
        )}

        <TabsContent value="history">
          <EntityHistoryTab entityType="user" entityId={user.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
