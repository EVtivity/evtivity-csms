// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Bot, Users } from 'lucide-react';
import type { DriverAiConsentDecision } from '@evtivity/lib/driver-ai';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const NOTICE_POINTS = ['automated', 'provider', 'person', 'choice'] as const;
const READS = ['case', 'sessions', 'tokens', 'payments', 'stations', 'reservations'] as const;

interface AiConsentStepProps {
  /** The notice version whose text is shown (and sent with the choice). */
  noticeVersion: number;
  onChoose: (decision: DriverAiConsentDecision) => void;
}

/**
 * Step 1 of a new case while the driver AI analysis is on (plan v0.1.45, 2.2
 * and 2.9 layer 1): the versioned notice, the data the AI reads, the driver
 * AI data note (`supportCases.ai.dataNotice`, verified in the AI data handling
 * rule), and two equal choices. Nothing is preselected and nothing is
 * remembered; the parent sends `aiConsent` only after a press.
 */
export function AiConsentStep({ noticeVersion, onChoose }: AiConsentStepProps): React.JSX.Element {
  const { t } = useTranslation();
  const notice = `supportCases.ai.notice.v${String(noticeVersion)}`;

  return (
    <section aria-labelledby="ai-consent-title" className="space-y-4">
      <h2 id="ai-consent-title" className="text-base font-semibold">
        {t('supportCases.ai.choiceTitle')}
      </h2>

      <Card>
        <CardContent className="space-y-3 p-4 text-sm">
          <h3 className="font-medium">{t(`${notice}.title`)}</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {NOTICE_POINTS.map((point) => (
              <li key={point}>{t(`${notice}.${point}`)}</li>
            ))}
          </ul>

          <details className="rounded-md border p-3">
            <summary className="cursor-pointer font-medium">{t(`${notice}.readsTitle`)}</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              {READS.map((item) => (
                <li key={item}>{t(`${notice}.reads.${item}`)}</li>
              ))}
            </ul>
          </details>

          <div className="space-y-1">
            <h3 className="font-medium">{t('supportCases.ai.dataNotice.title')}</h3>
            <p className="text-muted-foreground">{t('supportCases.ai.dataNotice.body')}</p>
          </div>

          <Link
            to="/privacy-policy"
            className="inline-block text-link underline-offset-4 hover:underline"
          >
            {t(`${notice}.privacy`)}
          </Link>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          size="row"
          onClick={() => {
            onChoose('granted');
          }}
        >
          <Bot className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('supportCases.ai.choiceAi')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="row"
          onClick={() => {
            onChoose('declined');
          }}
        >
          <Users className="mr-2 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('supportCases.ai.choiceTeam')}
        </Button>
      </div>
    </section>
  );
}
