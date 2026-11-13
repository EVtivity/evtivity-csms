// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The type1 face pictogram; its geometry and sources are TYPE1_FACE in
// @evtivity/lib/connector-faces.

import { TYPE1_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function Type1Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="type1" geometry={TYPE1_FACE} />;
}
