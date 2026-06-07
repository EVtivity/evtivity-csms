// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
import { useAuth } from '@/lib/auth';
import { LoadingLogo } from '@/components/loading-logo';

export function UserDetail(): React.JSX.Element {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const currentUserId = useAuth((s) => s.user?.id);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <BackButton to="/users" />
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">{user.email}</h1>
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
          <TabsTrigger value="security">{t('users.resetPassword')}</TabsTrigger>
          <TabsTrigger value="history">{t('audit.history')}</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <UserDetailsTab user={user} userId={user.id} roles={roles} />
        </TabsContent>

        <TabsContent value="permissions">
          <UserPermissionsTab userId={user.id} />
        </TabsContent>

        <TabsContent value="security">
          <UserSecurityTab userId={user.id} />
        </TabsContent>

        <TabsContent value="history">
          <EntityHistoryTab entityType="user" entityId={user.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
