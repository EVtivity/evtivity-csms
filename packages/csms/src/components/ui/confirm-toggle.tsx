// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './confirm-dialog';
import { Toggle, type ToggleProps } from './toggle';

export interface ConfirmToggleProps extends ToggleProps {
  /** The setting's name as the page shows it, named in the confirmation. */
  label: string;
  /** What stops when the setting is off; the dialog names the setting only when absent. */
  offDescription?: string;
}

/**
 * The settings switch: turning it on applies at once, turning it off asks
 * first (owner decision 2026-10-27). Confirm calls `onCheckedChange(false)`
 * exactly as the plain `Toggle` would, so a switch that saves on change still
 * saves and one inside a form still only marks the form changed. Cancel keeps
 * it on, and the dialog returns focus to the switch.
 */
const ConfirmToggle = React.forwardRef<HTMLButtonElement, ConfirmToggleProps>(
  ({ label, offDescription, onCheckedChange, ...props }, ref) => {
    const { t } = useTranslation();
    const [confirming, setConfirming] = React.useState(false);

    return (
      <>
        <Toggle
          ref={ref}
          {...props}
          onCheckedChange={(next) => {
            if (next) {
              onCheckedChange?.(true);
            } else {
              setConfirming(true);
            }
          }}
        />
        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('common.toggleOff.title')}
          description={t('common.toggleOff.description', { name: label })}
          confirmLabel={t('common.toggleOff.confirm')}
          cancelLabel={t('common.toggleOff.cancel')}
          onConfirm={() => {
            onCheckedChange?.(false);
          }}
        >
          {offDescription != null && offDescription !== '' && (
            <p className="text-sm text-muted-foreground" data-testid="confirm-toggle-off-effect">
              {offDescription}
            </p>
          )}
        </ConfirmDialog>
      </>
    );
  },
);
ConfirmToggle.displayName = 'ConfirmToggle';

export { ConfirmToggle };
