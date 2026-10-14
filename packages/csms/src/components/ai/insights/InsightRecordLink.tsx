// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useHasPermission } from '@/lib/auth';

/** Records an insight can name, with their detail page. */
const INSIGHT_RECORD_PATHS = {
  station: '/stations/',
  session: '/sessions/',
  site: '/sites/',
  reservation: '/reservations/',
  driver: '/drivers/',
  token: '/tokens/',
} as const;

export type InsightRecordKind = keyof typeof INSIGHT_RECORD_PATHS;

/**
 * Whether the user may open each kind of record (the read permission of its
 * detail route; a token page needs `drivers:read`). Literal permission names,
 * so the permission scan of the CSMS sees each one.
 */
function useRecordReadable(): Record<InsightRecordKind, boolean> {
  const stations = useHasPermission('stations:read');
  const sessions = useHasPermission('sessions:read');
  const sites = useHasPermission('sites:read');
  const reservations = useHasPermission('reservations:read');
  const drivers = useHasPermission('drivers:read');
  return {
    station: stations,
    session: sessions,
    site: sites,
    reservation: reservations,
    driver: drivers,
    token: drivers,
  };
}

/**
 * A record an insight names: a link to its detail page, labelled the way
 * people know the record (a station's OCPP id, a site's name, a reservation
 * number, a driver's name, an idToken). Without the read permission, or
 * without a label (the API sends none when the record no longer exists, or a
 * driver or token to a caller without `drivers:read`), it shows the plain id
 * instead of a link that would fail. The insight itself is already scoped to
 * the user's sites, and so are the station, session, site and reservation it
 * names. A click does not reach a clickable table row.
 */
export function InsightRecordLink({
  kind,
  id,
  label,
}: {
  kind: InsightRecordKind;
  id: string;
  /** The display label; null shows the plain id. */
  label: string | null | undefined;
}): React.JSX.Element {
  const canRead = useRecordReadable()[kind];
  if (!canRead || label == null || label === '') {
    return <span data-testid={`ai-insight-record-${kind}`}>{id}</span>;
  }
  return (
    <Link
      to={`${INSIGHT_RECORD_PATHS[kind]}${encodeURIComponent(id)}`}
      className="text-link hover:underline"
      data-testid={`ai-insight-record-${kind}`}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      {label}
    </Link>
  );
}
