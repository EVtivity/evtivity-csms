// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, desc } from 'drizzle-orm';
import argon2 from 'argon2';
import { db } from '@evtivity/database';
import { users } from '@evtivity/database';

export async function listUsers() {
  return db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      roleId: users.roleId,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
}

export async function getUser(id: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      roleId: users.roleId,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id));
  return user ?? null;
}

export async function createUser(data: {
  email: string;
  password: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  roleId: string;
}) {
  const passwordHash = await argon2.hash(data.password);
  const [user] = await db
    .insert(users)
    .values({
      email: data.email,
      passwordHash,
      ...(data.firstName != null ? { firstName: data.firstName } : {}),
      ...(data.lastName != null ? { lastName: data.lastName } : {}),
      roleId: data.roleId,
    })
    .returning({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      roleId: users.roleId,
    });
  return user;
}

export async function updateUser(
  id: string,
  data: {
    email?: string | undefined;
    firstName?: string | undefined;
    lastName?: string | undefined;
    isActive?: boolean | undefined;
    roleId?: string | undefined;
  },
) {
  const [user] = await db
    .update(users)
    .set({
      ...(data.email != null ? { email: data.email } : {}),
      ...(data.firstName != null ? { firstName: data.firstName } : {}),
      ...(data.lastName != null ? { lastName: data.lastName } : {}),
      ...(data.isActive != null ? { isActive: data.isActive } : {}),
      ...(data.roleId != null ? { roleId: data.roleId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      roleId: users.roleId,
      isActive: users.isActive,
    });
  return user ?? null;
}

export async function deleteUser(id: string) {
  const [user] = await db
    .update(users)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({
      id: users.id,
      email: users.email,
    });
  return user ?? null;
}

export async function changePassword(id: string, newPassword: string) {
  const passwordHash = await argon2.hash(newPassword);
  const [user] = await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  return user ?? null;
}
