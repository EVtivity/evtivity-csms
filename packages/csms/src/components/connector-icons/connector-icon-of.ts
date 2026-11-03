// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The face pictogram of each connector kind (`connectorKindOf`), for the 2D card.

import type { ConnectorKind } from '../layout/site-layout-connectors';
import type { ConnectorIconProps } from './connector-face';
import { Type1Icon } from './Type1Icon';
import { Type2Icon } from './Type2Icon';
import { Ccs1Icon } from './Ccs1Icon';
import { Ccs2Icon } from './Ccs2Icon';
import { ChademoIcon } from './ChademoIcon';
import { NacsIcon } from './NacsIcon';
import { McsIcon } from './McsIcon';

export const CONNECTOR_ICONS: Record<
  ConnectorKind,
  (props: ConnectorIconProps) => React.JSX.Element
> = {
  type1: Type1Icon,
  type2: Type2Icon,
  ccs1: Ccs1Icon,
  ccs2: Ccs2Icon,
  chademo: ChademoIcon,
  nacs: NacsIcon,
  mcs: McsIcon,
};
