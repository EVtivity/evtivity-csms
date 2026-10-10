// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { PersonalAiConfigCard } from '@/components/ai/AiConfigFields';

/** Profile > AI assistant: the user's own provider, key, model and effort. */
export function ProfileChatbotAi(): React.JSX.Element {
  return <PersonalAiConfigCard surface="chatbot" />;
}
