// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The ccs2 face pictogram; its geometry and sources are CCS2_FACE in
// @evtivity/lib/connector-faces.

import { CCS2_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function Ccs2Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="ccs2" geometry={CCS2_FACE} />;
}
