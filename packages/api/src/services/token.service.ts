// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { eq, and, or, ilike, sql, desc } from 'drizzle-orm';
import { db } from '@evtivity/database';
import { driverTokens, drivers } from '@evtivity/database';
import type { PaginationParams, PaginatedResponse } from '../lib/pagination.js';

interface TokenListParams extends PaginationParams {
  tokenType?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

const tokenSelect = {
  id: driverTokens.id,
  driverId: driverTokens.driverId,
  idToken: driverTokens.idToken,
  tokenType: driverTokens.tokenType,
  isActive: driverTokens.isActive,
  createdAt: driverTokens.createdAt,
  updatedAt: driverTokens.updatedAt,
  driverFirstName: drivers.firstName,
  driverLastName: drivers.lastName,
  driverEmail: drivers.email,
};

export async function listTokens(
  params: TokenListParams,
): Promise<
  PaginatedResponse<typeof tokenSelect extends infer S ? { [K in keyof S]: unknown } : never>
> {
  const { page, limit, search, tokenType, status } = params;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(driverTokens.id, pattern),
        ilike(driverTokens.idToken, pattern),
        ilike(drivers.firstName, pattern),
        ilike(drivers.lastName, pattern),
      ),
    );
  }
  if (tokenType != null) {
    conditions.push(eq(driverTokens.tokenType, tokenType));
  }
  if (status != null) {
    conditions.push(eq(driverTokens.isActive, status === 'active'));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, countRows] = await Promise.all([
    db
      .select(tokenSelect)
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where)
      .orderBy(desc(driverTokens.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(driverTokens)
      .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
      .where(where),
  ]);

  return { data, total: countRows[0]?.count ?? 0 };
}

export async function getToken(id: string) {
  const [token] = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(eq(driverTokens.id, id));
  return token ?? null;
}

export async function createToken(data: {
  driverId?: string | null | undefined;
  idToken: string;
  tokenType: string;
}) {
  const [token] = await db
    .insert(driverTokens)
    .values({
      idToken: data.idToken,
      tokenType: data.tokenType,
      driverId: data.driverId ?? null,
    })
    .returning();
  return token;
}

export async function updateToken(
  id: string,
  data: {
    idToken?: string | undefined;
    tokenType?: string | undefined;
    driverId?: string | null | undefined;
    isActive?: boolean | undefined;
  },
) {
  const [token] = await db
    .update(driverTokens)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(driverTokens.id, id))
    .returning();
  return token ?? null;
}

export async function deleteToken(id: string) {
  const [token] = await db.delete(driverTokens).where(eq(driverTokens.id, id)).returning();
  return token ?? null;
}

export async function exportTokensCsv(search?: string): Promise<string> {
  let where = undefined;
  if (search) {
    const pattern = `%${search}%`;
    where = or(
      ilike(driverTokens.id, pattern),
      ilike(driverTokens.idToken, pattern),
      ilike(drivers.firstName, pattern),
      ilike(drivers.lastName, pattern),
    );
  }

  const data = await db
    .select(tokenSelect)
    .from(driverTokens)
    .leftJoin(drivers, eq(driverTokens.driverId, drivers.id))
    .where(where);

  const header = 'idToken,tokenType,driverEmail,isActive';
  const rows = data.map((row) => {
    const email = row.driverEmail ?? '';
    const active = row.isActive ? 'true' : 'false';
    return `${csvEscape(row.idToken)},${csvEscape(row.tokenType)},${csvEscape(email)},${active}`;
  });

  return [header, ...rows].join('\n');
}

export async function importTokensCsv(
  rows: Array<{
    idToken: string;
    tokenType: string;
    driverEmail?: string | undefined;
    isActive?: boolean | undefined;
  }>,
): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  const values: Array<{
    idToken: string;
    tokenType: string;
    driverId?: string | null;
    isActive: boolean;
  }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row == null) continue;
    if (!row.idToken || !row.tokenType) {
      errors.push(`Row ${String(i + 1)}: missing idToken or tokenType`);
      continue;
    }

    let driverId: string | null = null;
    if (row.driverEmail) {
      const [driver] = await db
        .select({ id: drivers.id })
        .from(drivers)
        .where(eq(drivers.email, row.driverEmail));
      if (driver == null) {
        errors.push(`Row ${String(i + 1)}: driver not found for email ${row.driverEmail}`);
        continue;
      }
      driverId = driver.id;
    }

    values.push({
      idToken: row.idToken,
      tokenType: row.tokenType,
      driverId,
      isActive: row.isActive !== false,
    });
  }

  if (values.length > 0) {
    await db.insert(driverTokens).values(values);
  }

  return { imported: values.length, errors };
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
