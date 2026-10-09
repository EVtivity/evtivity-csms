// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Check, Circle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { passwordRuleResults } from '@evtivity/lib/password-policy';
import { cn } from '@/lib/utils';
import { passwordRuleLabel } from '@/lib/password-rules';

interface PasswordRequirementsProps {
  /** Referenced by the password input's `aria-describedby`. */
  id: string;
  password: string;
  /** After a submit attempt, unmet rules turn destructive. */
  showUnmet: boolean;
}

// The password rules of the API, checked live as the driver types.
export function PasswordRequirements({
  id,
  password,
  showUnmet,
}: PasswordRequirementsProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div id={id} className="space-y-1 text-xs" data-testid="password-requirements">
      <p className="text-muted-foreground">{t('validation.passwordNeeds')}</p>
      <ul className="space-y-1">
        {passwordRuleResults(password).map(({ rule, met }) => (
          <li
            key={rule}
            data-rule={rule}
            data-met={met}
            className={cn(
              'flex items-center gap-1.5',
              met ? 'text-success' : showUnmet ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {met ? (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{passwordRuleLabel(rule, t)}</span>
            <span className="sr-only">
              {met ? t('validation.passwordRuleMet') : t('validation.passwordRuleNotMet')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
