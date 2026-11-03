// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The station picture of the 2D card: the render of its 3D model in its
// charger plate color, else the plain drawing (while it renders, or without
// WebGL). Decorative: the card's ID and badges name the station.

import { THUMBNAIL_SIZE, type ThumbnailModel } from './site-layout-station-thumbnail';
import { useStationThumbnail } from './use-station-thumbnail';
import { useStationCardExtras } from './station-card-context';
import { StationPlainIcon } from './StationPlainIcon';

export function StationThumbnail({
  model,
  dc,
}: {
  model: ThumbnailModel;
  dc: boolean;
}): React.JSX.Element {
  const plates = useStationCardExtras().plateColors;
  const image = useStationThumbnail(model, dc ? plates.dc : plates.ac);
  const { width, height } = THUMBNAIL_SIZE;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width, height }}
      data-testid="station-card-thumbnail"
      data-model={model}
      data-rendered={image != null ? 'true' : 'false'}
    >
      {image != null ? (
        <img src={image} alt="" width={width} height={height} draggable={false} />
      ) : (
        <StationPlainIcon dc={dc} width={width - 4} height={height - 4} />
      )}
    </span>
  );
}
