// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PersonalAiConfigCard } from '@/components/ai/AiConfigFields';

/** Profile > Support AI: the user's own provider, key, model, effort and tone. */
export function ProfileSupportAi(): React.JSX.Element {
  return <PersonalAiConfigCard surface="support" />;
}
