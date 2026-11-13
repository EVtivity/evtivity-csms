// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The nacs face pictogram; its geometry and sources are NACS_FACE in
// @evtivity/lib/connector-faces.

import { NACS_FACE } from '@evtivity/lib/connector-faces';
import { ConnectorFace, type ConnectorIconProps } from './connector-face';

export function NacsIcon(props: ConnectorIconProps): React.JSX.Element {
  return <ConnectorFace {...props} kind="nacs" geometry={NACS_FACE} />;
}
