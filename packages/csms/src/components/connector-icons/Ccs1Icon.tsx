// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The ccs1 face pictogram; its geometry and sources are CCS1_FACE in
// @evtivity/lib/connector-faces.

import { CCS1_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function Ccs1Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="ccs1" geometry={CCS1_FACE} />;
}
