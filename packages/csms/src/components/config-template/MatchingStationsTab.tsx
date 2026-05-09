// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { MatchingStationsCard } from '@/components/MatchingStationsCard';

interface Props {
  templateId: string;
}

export function ConfigTemplateMatchingStationsTab({ templateId }: Props): React.JSX.Element {
  return (
    <MatchingStationsCard
      endpoint={`/v1/config-templates/${templateId}/matching-stations`}
      queryKey={['config-templates', templateId, 'matching-stations']}
    />
  );
}
