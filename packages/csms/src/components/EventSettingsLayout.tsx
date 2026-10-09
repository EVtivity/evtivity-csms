// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { InfoTooltip } from '@/components/ui/info-tooltip';
import { Toggle } from '@/components/ui/toggle';
import { LanguageSelect } from '@/components/ui/language-select';
import { TemplateEditPanel, type TemplateEditPanelHandle } from '@/components/TemplateEditPanel';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import { TEMPLATE_VARIABLES, COMMON_VARIABLES } from '@/lib/template-variables';

const CHANNEL_LABELS: Record<string, string> = {
  email: 'Email',
  sms: 'SMS',
  webhook: 'Webhook',
};

export interface EventSection {
  title: string;
  events: readonly string[];
}

/** One on/off switch per event type (all channels), saved as soon as it changes. */
export interface EventSwitch {
  /** Stored state per event type. No entry means on. */
  enabledMap: Map<string, boolean>;
  /** Event types that are always on: shown on and locked, with a tooltip. */
  isRequired: (eventType: string) => boolean;
  requiredTooltip: string;
  switchTooltip: string;
  canEdit: boolean;
  onChange: (eventType: string, enabled: boolean) => Promise<void>;
}

interface EventSettingsLayoutProps {
  sidebarTitle: string;
  emptyMessage: string;
  sections: EventSection[];
  channels: readonly string[];
  /** The channels one event type is sent on, when fewer than `channels`. */
  channelsFor?: (eventType: string) => readonly string[];
  channelTooltip?: string;
  toggleEndpoint?: string;
  toggleQueryKey?: string[];
  enabledMap?: Map<string, boolean>;
  defaultEnabled?: boolean;
  eventSwitch?: EventSwitch;
  renderSettingsExtra?: (props: {
    selectedEvent: string;
    channel: string;
    language: string;
  }) => React.ReactNode;
  /** Whether the settings extra differs from its stored value for this event and channel. */
  isSettingsExtraDirty?: (props: { selectedEvent: string; channel: string }) => boolean;
  onSave?: (props: {
    eventType: string;
    channel: string;
    language: string;
  }) => void | Promise<void>;
}

export function EventSettingsLayout({
  sidebarTitle,
  emptyMessage,
  sections,
  channels,
  channelsFor,
  channelTooltip,
  toggleEndpoint,
  toggleQueryKey,
  enabledMap,
  defaultEnabled,
  eventSwitch,
  renderSettingsExtra,
  isSettingsExtraDirty,
  onSave,
}: EventSettingsLayoutProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [selectedEvent, setSelectedEvent] = useState('');
  const [channelChoice, setChannel] = useState<string>(channels[0] ?? 'email');
  const eventChannels =
    selectedEvent !== '' ? (channelsFor?.(selectedEvent) ?? channels) : channels;
  // An event sent on fewer channels (driver.AccountVerification is email only) falls back to
  // its first channel instead of showing a template that is never sent.
  const channel = eventChannels.includes(channelChoice)
    ? channelChoice
    : (eventChannels[0] ?? channelChoice);
  const [language, setLanguage] = useState<string>('en');
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);
  // Local toggle override: tracks unsaved active/inactive state per eventType:channel
  const [localToggle, setLocalToggle] = useState<Map<string, boolean>>(new Map());
  const templatePanelRef = useRef<TemplateEditPanelHandle>(null);
  const [statusMessage, setStatusMessage] = useState({ success: '', error: '' });
  const [templateDirty, setTemplateDirty] = useState(false);

  const hasToggle = toggleEndpoint != null && toggleQueryKey != null && enabledMap != null;

  // Unsaved changes are differences from the stored values, never "a change event fired":
  // the template panel compares its fields with the loaded template, a toggle counts only
  // while it differs from the stored state, and the settings extra compares itself.
  const toggleDirty =
    hasToggle &&
    [...localToggle].some(([key, on]) => on !== (enabledMap.get(key) ?? defaultEnabled ?? false));
  const extraDirty =
    selectedEvent !== '' && (isSettingsExtraDirty?.({ selectedEvent, channel }) ?? false);
  const isDirty = templateDirty || toggleDirty || extraDirty;
  const dirtyRef = useRef(false);
  dirtyRef.current = isDirty;

  // Warn on browser navigation when dirty
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent): void {
      if (dirtyRef.current) {
        e.preventDefault();
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  const [switchSaving, setSwitchSaving] = useState(false);

  function isEventOn(et: string): boolean {
    if (eventSwitch == null) return true;
    return eventSwitch.isRequired(et) || (eventSwitch.enabledMap.get(et) ?? true);
  }

  async function changeEventSwitch(et: string, enabled: boolean): Promise<void> {
    if (eventSwitch == null) return;
    setSwitchSaving(true);
    try {
      await eventSwitch.onChange(et, enabled);
      setStatusMessage({
        success: enabled ? t('notifications.eventTurnedOn') : t('notifications.eventTurnedOff'),
        error: '',
      });
    } catch (err) {
      setStatusMessage({ success: '', error: getErrorMessage(err, t) });
    } finally {
      setSwitchSaving(false);
    }
  }

  const selectionComplete = selectedEvent !== '';
  const variables = [...COMMON_VARIABLES, ...(TEMPLATE_VARIABLES[selectedEvent] ?? [])];

  const onSelectEvent = useCallback((et: string) => {
    if (dirtyRef.current) {
      setPendingEvent(et);
      return;
    }
    setSelectedEvent(et);
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{sidebarTitle}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-y-auto max-h-[400px] md:max-h-[600px] px-4 pb-4 space-y-1">
              {sections.map((section) => (
                <div key={section.title}>
                  {
                    <p className="text-xs font-semibold text-primary/70 uppercase tracking-wide px-2 py-1.5 mt-2 rounded bg-primary/5 border border-primary/10">
                      {section.title}
                    </p>
                  }
                  {section.events.map((et) => {
                    const isSelected = selectedEvent === et;
                    const anyEnabled = hasToggle
                      ? (channelsFor?.(et) ?? channels).some((ch) => {
                          const key = `${et}:${ch}`;
                          return (
                            localToggle.get(key) ?? enabledMap.get(key) ?? defaultEnabled ?? false
                          );
                        })
                      : false;
                    return (
                      <div
                        key={et}
                        className={`flex items-center justify-between p-2 rounded cursor-pointer ${
                          isSelected ? 'bg-accent' : 'hover:bg-muted'
                        }`}
                        onClick={() => {
                          onSelectEvent(et);
                        }}
                      >
                        <span className="text-sm truncate mr-2">{et}</span>
                        {hasToggle && (
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${anyEnabled ? 'bg-success' : 'bg-muted-foreground/30'}`}
                          />
                        )}
                        {eventSwitch != null && (
                          <span
                            data-testid={`event-switch-dot-${et}`}
                            className={`h-2 w-2 shrink-0 rounded-full ${isEventOn(et) ? 'bg-success' : 'bg-muted-foreground/30'}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        {!selectionComplete && (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </CardContent>
          </Card>
        )}

        {selectionComplete &&
          (() => {
            const toggleKey = `${selectedEvent}:${channel}`;
            const isActive = hasToggle
              ? (localToggle.get(toggleKey) ?? enabledMap.get(toggleKey) ?? defaultEnabled ?? false)
              : true;
            return (
              <>
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4">
                  <h3 className="text-lg font-semibold">{selectedEvent}</h3>
                  <div className="flex items-center gap-2">
                    {statusMessage.success !== '' && (
                      <p className="text-sm text-success">{statusMessage.success}</p>
                    )}
                    {statusMessage.error !== '' && (
                      <p className="text-sm text-destructive">{statusMessage.error}</p>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => {
                        templatePanelRef.current?.preview();
                      }}
                      disabled={templatePanelRef.current?.isPreviewPending}
                    >
                      {t('notifications.preview')}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        templatePanelRef.current?.reset();
                      }}
                      disabled={templatePanelRef.current?.isPending}
                    >
                      {t('notifications.resetToDefault')}
                    </Button>
                    <Button
                      onClick={() => {
                        templatePanelRef.current?.save();
                      }}
                      disabled={!isDirty || templatePanelRef.current?.isPending}
                    >
                      {t('notifications.save')}
                    </Button>
                  </div>
                </div>
                <Card>
                  <CardContent className="p-6 space-y-4">
                    <div className="grid gap-4 sm:grid-cols-3">
                      {eventSwitch != null &&
                        (() => {
                          const required = eventSwitch.isRequired(selectedEvent);
                          const on = isEventOn(selectedEvent);
                          return (
                            <div className="space-y-2">
                              <Label
                                htmlFor="event-switch"
                                className="inline-flex items-center gap-1 leading-6"
                              >
                                {on ? t('common.active') : t('common.inactive')}
                                <InfoTooltip
                                  content={
                                    required
                                      ? eventSwitch.requiredTooltip
                                      : eventSwitch.switchTooltip
                                  }
                                />
                              </Label>
                              <div className="flex h-10 items-center">
                                <Toggle
                                  id="event-switch"
                                  checked={on}
                                  disabled={required || !eventSwitch.canEdit || switchSaving}
                                  onCheckedChange={(next) => {
                                    void changeEventSwitch(selectedEvent, next);
                                  }}
                                />
                              </div>
                            </div>
                          );
                        })()}
                      <div className="space-y-2">
                        <Label className="inline-flex items-center gap-1 leading-6">
                          {t('notifications.channel')}
                          {channelTooltip != null && <InfoTooltip content={channelTooltip} />}
                        </Label>
                        <div className="flex rounded-md border border-input overflow-hidden">
                          {eventChannels.map((ch) => (
                            <button
                              key={ch}
                              type="button"
                              onClick={() => {
                                setChannel(ch);
                              }}
                              className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                                channel === ch
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-background text-muted-foreground hover:bg-muted'
                              }`}
                            >
                              {CHANNEL_LABELS[ch] ?? ch}
                            </button>
                          ))}
                        </div>
                      </div>
                      {hasToggle && (
                        <div className="space-y-2">
                          <Label className="leading-6">
                            {isActive ? t('common.active') : t('common.inactive')}
                          </Label>
                          <div className="flex h-10 items-center">
                            <button
                              type="button"
                              role="switch"
                              aria-checked={isActive}
                              onClick={() => {
                                setLocalToggle((prev) => {
                                  const next = new Map(prev);
                                  next.set(toggleKey, !isActive);
                                  return next;
                                });
                              }}
                              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
                                isActive ? 'bg-primary' : 'bg-muted'
                              }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ${
                                  isActive ? 'translate-x-4' : 'translate-x-0'
                                }`}
                              />
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="space-y-2">
                        <Label className="leading-6">{t('notifications.language')}</Label>
                        <LanguageSelect value={language} onChange={setLanguage} />
                      </div>
                    </div>

                    <div className={!isActive ? 'opacity-50 pointer-events-none' : ''}>
                      {renderSettingsExtra?.({
                        selectedEvent,
                        channel,
                        language,
                      })}
                    </div>
                  </CardContent>
                </Card>

                <TemplateEditPanel
                  ref={templatePanelRef}
                  disabled={!isActive}
                  key={`${selectedEvent}:${channel}:${language}`}
                  eventType={selectedEvent}
                  channel={channel as 'email' | 'sms' | 'webhook'}
                  language={language}
                  variables={variables}
                  onDirtyChange={setTemplateDirty}
                  onStatusChange={setStatusMessage}
                  onSave={
                    onSave != null
                      ? async () => {
                          const toggleVal = localToggle.get(toggleKey);
                          const savingAsInactive = hasToggle && toggleVal === false;

                          if (savingAsInactive) {
                            // Delete the setting from DB when deactivating
                            await api.delete(
                              `${toggleEndpoint}?eventType=${encodeURIComponent(selectedEvent)}&channel=${encodeURIComponent(channel)}`,
                            );
                            await queryClient.refetchQueries({ queryKey: toggleQueryKey });
                            setStatusMessage({
                              success: t('notifications.templateDeactivated'),
                              error: '',
                            });
                          } else {
                            await onSave({ eventType: selectedEvent, channel, language });
                            setStatusMessage({
                              success: t('notifications.templateSaved'),
                              error: '',
                            });
                          }
                          setLocalToggle((prev) => {
                            const next = new Map(prev);
                            next.delete(toggleKey);
                            return next;
                          });
                        }
                      : undefined
                  }
                />
              </>
            );
          })()}
      </div>

      <ConfirmDialog
        open={pendingEvent != null}
        onOpenChange={(open) => {
          if (!open) setPendingEvent(null);
        }}
        title={t('notifications.unsavedChangesWarning')}
        description={t('notifications.unsavedChangesDescription')}
        confirmLabel={t('common.confirm')}
        variant="default"
        onConfirm={() => {
          if (pendingEvent != null) {
            setSelectedEvent(pendingEvent);
            setLocalToggle(new Map());
            setPendingEvent(null);
          }
        }}
      />
    </div>
  );
}
