// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The chademo face pictogram; its geometry and sources are CHADEMO_FACE in
// @evtivity/lib/connector-faces.

import { CHADEMO_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function ChademoIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="chademo" geometry={CHADEMO_FACE} />;
}
