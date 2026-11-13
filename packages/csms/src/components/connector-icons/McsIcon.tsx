// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The mcs face pictogram; its geometry and sources are MCS_FACE in
// @evtivity/lib/connector-faces.

import { MCS_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function McsIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="mcs" geometry={MCS_FACE} />;
}
