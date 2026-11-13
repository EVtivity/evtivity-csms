// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoNote } from '@/components/ui/info-note';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { ButtonPendingLabel } from '@/components/ButtonPendingLabel';
import { SavedMessage } from '@/components/saved-message';

// Notification preferences per event and channel (discussion 56). The operator
// decides first: an event it turned off is not listed, a mandatory one is shown
// on and locked. The web portal manages email and SMS; native push is the mobile
// app's. Only channels the operator has configured are shown.

type Channel = 'email' | 'sms';
const PORTAL_CHANNELS: readonly Channel[] = ['email', 'sms'];

interface ChannelState {
  enabled: boolean;
  mandatory: boolean;
}

interface PreferenceEvent {
  eventType: string;
  group: string;
  email: ChannelState;
  sms: ChannelState;
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  channels: { email: boolean; sms: boolean; push: boolean };
  events: PreferenceEvent[];
}

const PATH = '/v1/portal/driver/notification-preferences';

export function AccountNotificationPrefs(): React.JSX.Element {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<NotificationPreferences | null>(null);
  const [events, setEvents] = useState<PreferenceEvent[]>([]);
  const [switchTouched, setSwitchTouched] = useState<Partial<Record<Channel, boolean>>>({});
  const [msg, setMsg] = useState('');
  const [saveResult, setSaveResult] = useState<
    { kind: 'success' } | { kind: 'error'; text: string } | null
  >(null);
  const [loading, setLoading] = useState(false);

  function take(prefs: NotificationPreferences): void {
    setLoaded(prefs);
    setEvents(prefs.events);
    setSwitchTouched({});
  }

  useEffect(() => {
    void api
      .get<NotificationPreferences>(PATH)
      .then(take)
      .catch((err: unknown) => {
        setMsg(getErrorMessage(err, t, 'profile.preferencesFailed'));
      });
  }, [t]);

  const channels = PORTAL_CHANNELS.filter((channel) => loaded?.channels[channel] === true);

  // The "All" checkbox of a channel: checked when every optional event is on,
  // mixed when some are.
  function allState(channel: Channel): { checked: boolean; indeterminate: boolean } {
    const optional = events.filter((e) => !e[channel].mandatory);
    const on = optional.filter((e) => e[channel].enabled).length;
    if (optional.length === 0) return { checked: true, indeterminate: false };
    return { checked: on === optional.length, indeterminate: on > 0 && on < optional.length };
  }

  function setAll(channel: Channel, enabled: boolean): void {
    setSwitchTouched((prev) => ({ ...prev, [channel]: enabled }));
    setEvents((prev) =>
      prev.map((e) => (e[channel].mandatory ? e : { ...e, [channel]: { ...e[channel], enabled } })),
    );
  }

  function setOne(eventType: string, channel: Channel, enabled: boolean): void {
    setEvents((prev) =>
      prev.map((e) =>
        e.eventType === eventType && !e[channel].mandatory
          ? { ...e, [channel]: { ...e[channel], enabled } }
          : e,
      ),
    );
  }

  const groups = useMemo(() => {
    const out: Array<{ group: string; events: PreferenceEvent[] }> = [];
    for (const e of events) {
      const last = out.at(-1);
      if (last?.group === e.group) last.events.push(e);
      else out.push({ group: e.group, events: [e] });
    }
    return out;
  }, [events]);

  const hasMandatory = events.some((e) => channels.some((c) => e[c].mandatory));

  async function handleSave(e: React.SyntheticEvent): Promise<void> {
    e.preventDefault();
    if (loaded == null) return;
    setMsg('');
    setSaveResult(null);
    setLoading(true);
    try {
      const before = new Map(loaded.events.map((ev) => [ev.eventType, ev]));
      const changes: Array<{ eventType: string; channel: Channel; enabled: boolean }> = [];
      for (const ev of events) {
        for (const channel of channels) {
          if (ev[channel].mandatory) continue;
          if (before.get(ev.eventType)?.[channel].enabled !== ev[channel].enabled) {
            changes.push({ eventType: ev.eventType, channel, enabled: ev[channel].enabled });
          }
        }
      }
      const body: Record<string, unknown> = {};
      if (switchTouched.email != null) body['emailEnabled'] = switchTouched.email;
      if (switchTouched.sms != null) body['smsEnabled'] = switchTouched.sms;
      if (changes.length > 0) body['events'] = changes;
      const saved = await api.put<NotificationPreferences>(PATH, body);
      take(saved);
      setSaveResult({ kind: 'success' });
    } catch (err) {
      setSaveResult({ kind: 'error', text: getErrorMessage(err, t, 'profile.preferencesFailed') });
    } finally {
      setLoading(false);
    }
  }

  const channelLabel = (channel: Channel): string => t(`notificationPrefs.channels.${channel}`);
  const eventLabel = (eventType: string): string => t(`notificationPrefs.events.${eventType}`);

  return (
    <form onSubmit={(e) => void handleSave(e)} className="space-y-4">
      {msg !== '' && <p className="text-sm text-destructive">{msg}</p>}
      {loaded != null && channels.length === 0 && (
        <InfoNote>{t('notificationPrefs.noChannels')}</InfoNote>
      )}
      {loaded != null && channels.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">{t('notificationPrefs.intro')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="notification-matrix">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-2 text-left font-medium">
                    {t('notificationPrefs.notification')}
                  </th>
                  {channels.map((channel) => (
                    <th key={channel} className="w-20 py-2 text-center font-medium">
                      {channelLabel(channel)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="py-2 pr-2 font-medium">
                    {t('notificationPrefs.allNotifications')}
                  </td>
                  {channels.map((channel) => {
                    const state = allState(channel);
                    return (
                      <td key={channel} className="py-2 text-center">
                        <Checkbox
                          aria-label={t('notificationPrefs.allChannelLabel', {
                            channel: channelLabel(channel),
                          })}
                          checked={state.checked}
                          indeterminate={state.indeterminate}
                          onChange={() => {
                            setAll(channel, !state.checked);
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
                {groups.map(({ group, events: groupEvents }) => (
                  <Fragment key={group}>
                    <tr>
                      <th
                        colSpan={channels.length + 1}
                        scope="colgroup"
                        className="pt-4 pb-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {t(`notificationPrefs.groups.${group}`)}
                      </th>
                    </tr>
                    {groupEvents.map((ev) => (
                      <tr key={ev.eventType} className="border-b last:border-0">
                        <td className="py-2 pr-2">{eventLabel(ev.eventType)}</td>
                        {channels.map((channel) => {
                          const state = ev[channel];
                          const name = t('notificationPrefs.eventChannelLabel', {
                            event: eventLabel(ev.eventType),
                            channel: channelLabel(channel),
                          });
                          return (
                            <td key={channel} className="py-2 text-center">
                              <span
                                className="inline-flex items-center gap-1"
                                title={
                                  state.mandatory ? t('notificationPrefs.required') : undefined
                                }
                              >
                                <Checkbox
                                  aria-label={name}
                                  aria-describedby={
                                    state.mandatory ? 'notification-required-note' : undefined
                                  }
                                  checked={state.enabled}
                                  disabled={state.mandatory}
                                  onChange={(e) => {
                                    setOne(ev.eventType, channel, e.target.checked);
                                  }}
                                />
                                {state.mandatory && (
                                  <Lock
                                    className="h-3 w-3 text-muted-foreground"
                                    aria-label={t('notificationPrefs.required')}
                                    data-testid={`required-${ev.eventType}-${channel}`}
                                  />
                                )}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {hasMandatory && (
            <p id="notification-required-note" className="text-xs text-muted-foreground">
              {t('notificationPrefs.requiredNote')}
            </p>
          )}
          <Button type="submit" className="relative w-full" disabled={loading}>
            <ButtonPendingLabel pending={loading}>{t('common.save')}</ButtonPendingLabel>
          </Button>
          {saveResult?.kind === 'success' && (
            <SavedMessage>{t('profile.preferencesSaved')}</SavedMessage>
          )}
          {saveResult?.kind === 'error' && (
            <p className="text-sm text-destructive">{saveResult.text}</p>
          )}
        </>
      )}
      <p className="text-xs text-muted-foreground">{t('notificationPrefs.alwaysSentNote')}</p>
    </form>
  );
}
