// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The type2 face pictogram; its geometry and sources are TYPE2_FACE in
// @evtivity/lib/connector-faces.

import { TYPE2_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function Type2Icon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="type2" geometry={TYPE2_FACE} />;
}
