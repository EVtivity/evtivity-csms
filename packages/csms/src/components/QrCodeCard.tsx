// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useQrIcon } from '@/hooks/use-qr-icon';
import { Button } from '@/components/ui/button';
import { PORTAL_BASE_URL } from '@/lib/config';

export interface QrCodeCardProps {
  stationOcppId: string;
  evseId: number;
  svgIdPrefix?: string;
  showStationId?: boolean;
  guestChargingEnabled: boolean;
}

export function QrCodeCard({
  stationOcppId,
  evseId,
  svgIdPrefix = 'qr',
  showStationId = false,
  guestChargingEnabled,
}: QrCodeCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { svgDataUri: qrIconSrc } = useQrIcon();

  const portalUrl = `${PORTAL_BASE_URL}/charge/${stationOcppId}/${String(evseId)}`;
  const svgId = `${svgIdPrefix}-${stationOcppId}-${String(evseId)}`;

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border p-4">
      <QRCodeSVG
        id={svgId}
        value={portalUrl}
        size={160}
        level={qrIconSrc != null ? 'H' : 'M'}
        marginSize={4}
        {...(qrIconSrc != null
          ? { imageSettings: { src: qrIconSrc, height: 32, width: 32, excavate: true } }
          : {})}
      />
      <p className="text-sm font-medium">
        {showStationId ? `${stationOcppId} - ` : ''}
        {t('stations.port', { id: evseId })}
      </p>
      {guestChargingEnabled && (
        <a
          href={portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline break-all text-center"
        >
          {portalUrl}
        </a>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const svg = document.getElementById(svgId);
          if (svg == null) return;
          const svgData = new XMLSerializer().serializeToString(svg);
          const blob = new Blob([svgData], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `qr-${stationOcppId}-evse-${String(evseId)}.svg`;
          a.click();
          URL.revokeObjectURL(url);
        }}
      >
        <Download className="h-4 w-4" />
        {t('common.download')}
      </Button>
    </div>
  );
}
