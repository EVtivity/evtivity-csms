// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { SaveButton } from '@/components/save-button';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';

type StationMessageState =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'charging'
  | 'suspended'
  | 'discharging'
  | 'faulted'
  | 'unavailable'
  | 'payment_failed'
  | 'payment_required'
  | 'guest_unauthorized'
  | 'unauthorized';

interface TemplateRow {
  state: StationMessageState;
  body: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface ListResponse {
  data: TemplateRow[];
}

interface PreviewResponse {
  rendered: string;
}

interface VariableDef {
  name: string;
  descriptionKey: string;
  states: ReadonlySet<StationMessageState>;
}

const ALL: ReadonlySet<StationMessageState> = new Set([
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
  'payment_failed',
  'payment_required',
  'guest_unauthorized',
  'unauthorized',
]);

const VARIABLES: VariableDef[] = [
  { name: 'companyName', descriptionKey: 'messages.varCompanyName', states: ALL },
  { name: 'stationOcppId', descriptionKey: 'messages.varStationOcppId', states: ALL },
  { name: 'supportPhone', descriptionKey: 'messages.varSupportPhone', states: ALL },
  {
    name: 'pricingDisplay',
    descriptionKey: 'messages.varPricingDisplay',
    states: new Set(['available']),
  },
  {
    name: 'energyKwh',
    descriptionKey: 'messages.varEnergyKwh',
    states: new Set(['charging', 'suspended', 'discharging']),
  },
  {
    name: 'powerKw',
    descriptionKey: 'messages.varPowerKw',
    states: new Set(['charging', 'discharging']),
  },
  {
    name: 'costFormatted',
    descriptionKey: 'messages.varCostFormatted',
    states: new Set(['charging', 'suspended', 'discharging']),
  },
  {
    name: 'elapsedFormatted',
    descriptionKey: 'messages.varElapsedFormatted',
    states: new Set(['charging', 'suspended', 'discharging']),
  },
  {
    name: 'idleFeeRate',
    descriptionKey: 'messages.varIdleFeeRate',
    states: new Set(['suspended']),
  },
  {
    name: 'driverFirstName',
    descriptionKey: 'messages.varDriverFirstName',
    states: new Set(['charging', 'suspended', 'reserved']),
  },
  {
    name: 'reservationExpiresAt',
    descriptionKey: 'messages.varReservationExpiresAt',
    states: new Set(['reserved']),
  },
];

const STATES: StationMessageState[] = [
  'available',
  'occupied',
  'reserved',
  'charging',
  'suspended',
  'discharging',
  'faulted',
  'unavailable',
  // Event-driven one-shot messages. Not bound to a MessageState slot; pushed
  // by server-side flows (e.g. payment gate stopping a session) with TTL.
  'payment_failed',
  'payment_required',
  'guest_unauthorized',
  'unauthorized',
];

const STATE_LABEL_KEY: Record<StationMessageState, string> = {
  available: 'messages.stateAvailable',
  occupied: 'messages.stateOccupied',
  reserved: 'messages.stateReserved',
  charging: 'messages.stateCharging',
  suspended: 'messages.stateSuspended',
  discharging: 'messages.stateDischarging',
  faulted: 'messages.stateFaulted',
  unavailable: 'messages.stateUnavailable',
  payment_failed: 'messages.statePaymentFailed',
  payment_required: 'messages.statePaymentRequired',
  guest_unauthorized: 'messages.stateGuestUnauthorized',
  unauthorized: 'messages.stateUnauthorized',
};

interface StationMessageSettingsProps {
  settings: Record<string, unknown> | undefined;
}

export function StationMessageSettings({
  settings,
}: StationMessageSettingsProps): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Settings keys
  const [enabled, setEnabled] = useState(false);
  const [pricingFormat, setPricingFormat] = useState('compact');
  const [refreshSeconds, setRefreshSeconds] = useState('30');
  const [brandLine, setBrandLine] = useState('');

  useEffect(() => {
    if (settings == null) return;
    setEnabled(settings['stationMessage.enabled'] === true);
    const fmt = settings['stationMessage.pricingFormat'];
    setPricingFormat(typeof fmt === 'string' ? fmt : 'compact');
    const refresh = settings['stationMessage.charging.refreshSeconds'];
    if (typeof refresh === 'number') {
      setRefreshSeconds(refresh.toString());
    } else if (typeof refresh === 'string' && refresh !== '') {
      setRefreshSeconds(refresh);
    } else {
      setRefreshSeconds('30');
    }
    const brand = settings['stationMessage.brandLine'];
    setBrandLine(typeof brand === 'string' ? brand : '');
  }, [settings]);

  // Templates list
  const { data: templates } = useQuery({
    queryKey: ['station-message-templates'],
    queryFn: () => api.get<ListResponse>('/v1/station-message-templates'),
  });

  const [selectedState, setSelectedState] = useState<StationMessageState>('available');
  const [bodyDraft, setBodyDraft] = useState('');
  const [originalBody, setOriginalBody] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const templatesByState = useMemo(() => {
    const map = new Map<StationMessageState, TemplateRow>();
    if (templates != null) {
      for (const row of templates.data) {
        map.set(row.state, row);
      }
    }
    return map;
  }, [templates]);

  useEffect(() => {
    const row = templatesByState.get(selectedState);
    const body = row?.body ?? '';
    setBodyDraft(body);
    setOriginalBody(body);
  }, [selectedState, templatesByState]);

  // Settings mutation
  const settingsMutation = useMutation({
    mutationFn: (vals: {
      enabled: boolean;
      pricingFormat: string;
      refreshSeconds: number;
      brandLine: string;
    }) =>
      Promise.all([
        api.put('/v1/settings/stationMessage.enabled', { value: vals.enabled }),
        api.put('/v1/settings/stationMessage.pricingFormat', { value: vals.pricingFormat }),
        api.put('/v1/settings/stationMessage.charging.refreshSeconds', {
          value: vals.refreshSeconds,
        }),
        api.put('/v1/settings/stationMessage.brandLine', { value: vals.brandLine }),
      ]),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast({ title: t('messages.settingsSaved'), variant: 'success' });
    },
    onError: () => {
      toast({ title: t('messages.settingsSaveFailed'), variant: 'destructive' });
    },
  });

  // Template save
  const saveMutation = useMutation({
    mutationFn: (vals: { state: StationMessageState; body: string }) =>
      api.put<TemplateRow>(`/v1/station-message-templates/${vals.state}`, { body: vals.body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['station-message-templates'] });
      toast({ title: t('messages.saved'), variant: 'success' });
    },
    onError: () => {
      toast({ title: t('messages.saveFailed'), variant: 'destructive' });
    },
  });

  // Reset to default
  const resetMutation = useMutation({
    mutationFn: (state: StationMessageState) =>
      api.delete<TemplateRow>(`/v1/station-message-templates/${state}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['station-message-templates'] });
      toast({ title: t('messages.resetSuccess'), variant: 'success' });
    },
    onError: () => {
      toast({ title: t('messages.saveFailed'), variant: 'destructive' });
    },
  });

  // Preview (debounced)
  const [preview, setPreview] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.post<PreviewResponse>('/v1/station-message-templates/preview', {
            state: selectedState,
            body: bodyDraft,
          });
          setPreview(result.rendered);
        } catch {
          setPreview('');
        }
      })();
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [selectedState, bodyDraft]);

  const visibleVariables = useMemo(
    () => VARIABLES.filter((v) => v.states.has(selectedState)),
    [selectedState],
  );

  function insertVariableAtCursor(name: string): void {
    const token = `{{${name}}}`;
    const ta = textareaRef.current;
    if (ta == null) {
      setBodyDraft((prev) => prev + token);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = bodyDraft.slice(0, start) + token + bodyDraft.slice(end);
    setBodyDraft(next);
    requestAnimationFrame(() => {
      ta.selectionStart = start + token.length;
      ta.selectionEnd = start + token.length;
      ta.focus();
    });
  }

  const refreshSecondsNumber = Number(refreshSeconds);
  const refreshSecondsValid = Number.isFinite(refreshSecondsNumber) && refreshSecondsNumber > 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('messages.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('messages.description')}</p>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!refreshSecondsValid) return;
              settingsMutation.mutate({
                enabled,
                pricingFormat,
                refreshSeconds: refreshSecondsNumber,
                brandLine,
              });
            }}
            noValidate
          >
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="station-message-enabled">{t('messages.enabled')}</Label>
                <p className="text-xs text-muted-foreground">{t('messages.enabledDesc')}</p>
              </div>
              <Toggle
                id="station-message-enabled"
                size="lg"
                checked={enabled}
                onCheckedChange={(v) => {
                  setEnabled(v);
                }}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="station-message-pricing-format">
                  {t('messages.pricingFormat')}
                </Label>
                <Select
                  id="station-message-pricing-format"
                  value={pricingFormat}
                  onChange={(e) => {
                    setPricingFormat(e.target.value);
                  }}
                >
                  <option value="compact">{t('settings.displayFormatCompact')}</option>
                  <option value="standard">{t('settings.displayFormatStandard')}</option>
                </Select>
                <p className="text-xs text-muted-foreground">{t('messages.pricingFormatDesc')}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="station-message-refresh-seconds">
                  {t('messages.refreshSeconds')}
                </Label>
                <Input
                  id="station-message-refresh-seconds"
                  type="number"
                  min={5}
                  step={1}
                  value={refreshSeconds}
                  onChange={(e) => {
                    setRefreshSeconds(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">{t('messages.refreshSecondsDesc')}</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="station-message-brand-line">{t('messages.brandLine')}</Label>
              <Input
                id="station-message-brand-line"
                value={brandLine}
                onChange={(e) => {
                  setBrandLine(e.target.value);
                }}
              />
              <p className="text-xs text-muted-foreground">{t('messages.brandLineDesc')}</p>
            </div>

            <SaveButton isPending={settingsMutation.isPending} />
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="grid grid-cols-1 md:grid-cols-[220px_1fr]">
            <div className="border-b md:border-b-0 md:border-r" role="tablist">
              {STATES.map((state) => {
                const active = state === selectedState;
                return (
                  <button
                    key={state}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setSelectedState(state);
                    }}
                    className={`block w-full px-4 py-3 text-left text-sm transition-colors ${
                      active
                        ? 'bg-primary/10 font-medium text-primary'
                        : 'hover:bg-muted text-foreground'
                    }`}
                  >
                    {t(STATE_LABEL_KEY[state] as never)}
                  </button>
                );
              })}
            </div>
            <div className="space-y-4 p-6">
              <div className="space-y-2">
                <Label htmlFor="station-message-body">{t('messages.bodyLabel')}</Label>
                <textarea
                  id="station-message-body"
                  ref={textareaRef}
                  value={bodyDraft}
                  onChange={(e) => {
                    setBodyDraft(e.target.value);
                  }}
                  placeholder={t('messages.bodyPlaceholder')}
                  className="flex min-h-[160px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  {t('messages.variablesLabel')}
                </Label>
                <div className="flex flex-wrap gap-2">
                  {visibleVariables.map((v) => (
                    <button
                      key={v.name}
                      type="button"
                      onClick={() => {
                        insertVariableAtCursor(v.name);
                      }}
                      title={t(v.descriptionKey as never)}
                      className="cursor-pointer rounded bg-muted px-2 py-1 text-sm transition-colors hover:bg-muted/80"
                    >
                      {`{{${v.name}}}`}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('messages.variableHint')}</p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">{t('messages.preview')}</Label>
                <pre className="min-h-[6rem] whitespace-pre-wrap break-words rounded-md border bg-muted/30 px-3 py-2 font-mono text-sm">
                  {preview}
                </pre>
                <p className="text-xs text-muted-foreground">{t('messages.previewHint')}</p>
              </div>

              <Alert variant="info">
                <AlertDescription>{t('messages.description')}</AlertDescription>
              </Alert>

              <div className="flex justify-end flex-wrap items-center gap-3">
                <SaveButton
                  isPending={saveMutation.isPending}
                  type="button"
                  disabled={bodyDraft === originalBody}
                  onClick={() => {
                    saveMutation.mutate({ state: selectedState, body: bodyDraft });
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setResetOpen(true);
                  }}
                  disabled={resetMutation.isPending}
                >
                  <RotateCcw className="h-4 w-4" />
                  {t('messages.resetToDefault')}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t('messages.resetToDefault')}
        description={t('messages.confirmReset')}
        confirmLabel={t('messages.resetToDefault')}
        variant="destructive"
        isPending={resetMutation.isPending}
        onConfirm={() => {
          resetMutation.mutate(selectedState);
        }}
      />
    </div>
  );
}
