// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { BackButton } from '@/components/back-button';
import { Search, X } from 'lucide-react';
import { CancelButton } from '@/components/cancel-button';
import { CreateButton } from '@/components/create-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { DriverCombobox } from '@/components/driver-combobox';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';

interface SupportCase {
  id: string;
}

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

const CATEGORY_OPTIONS = [
  'billing_dispute',
  'charging_failure',
  'connector_damage',
  'account_issue',
  'payment_problem',
  'reservation_issue',
  'general_inquiry',
] as const;

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'urgent'] as const;

export function SupportCaseCreate(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('general_inquiry');
  const [priority, setPriority] = useState<string>('medium');
  const [selectedDriver, setSelectedDriver] = useState<{ id: string; name: string } | null>(null);
  const [assignedTo, setAssignedTo] = useState('');
  const [selectedSessions, setSelectedSessions] = useState<
    Array<{ id: string; transactionId: string }>
  >([]);
  const [sessionSearchText, setSessionSearchText] = useState('');
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const { data: operatorUsers } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api.get<{ data: User[] }>('/v1/users?limit=100'),
  });

  const { data: sessionResults } = useQuery({
    queryKey: ['session-search-create', sessionSearchText],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; transactionId: string }> }>(
        `/v1/sessions?search=${encodeURIComponent(sessionSearchText)}&limit=5`,
      ),
    enabled: sessionSearchText.length >= 2,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => api.post<SupportCase>('/v1/support-cases', data),
    onSuccess: (created) => {
      void navigate(`/support-cases/${created.id}`);
    },
  });

  function getValidationErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    if (subject.trim() === '') errors.subject = t('validation.required');
    if (description.trim() === '') errors.description = t('validation.required');
    return errors;
  }

  const errors = getValidationErrors();

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const body: Record<string, unknown> = {
      subject,
      description,
      category,
      priority,
    };
    if (selectedDriver != null) body.driverId = selectedDriver.id;
    if (assignedTo !== '') body.assignedTo = assignedTo;
    if (selectedSessions.length > 0) body.sessionIds = selectedSessions.map((s) => s.id);
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <BackButton to="/support-cases" />
        <h1 className="text-2xl font-bold md:text-3xl">{t('supportCases.createCase')}</h1>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subject">{t('supportCases.subject')}</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                }}
                className={hasSubmitted && errors.subject ? 'border-destructive' : ''}
              />
              {hasSubmitted && errors.subject && (
                <p className="text-sm text-destructive">{errors.subject}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">{t('supportCases.description')}</Label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
                className={`flex w-full rounded-md border bg-background px-3 py-2 text-sm ${hasSubmitted && errors.description ? 'border-destructive' : 'border-input'}`}
                rows={3}
              />
              {hasSubmitted && errors.description && (
                <p className="text-sm text-destructive">{errors.description}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="case-category-select">{t('supportCases.category')}</Label>
                <Select
                  id="case-category-select"
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                  }}
                >
                  {CATEGORY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {t(`supportCases.categories.${c}`)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="case-priority-select">{t('supportCases.priority')}</Label>
                <Select
                  id="case-priority-select"
                  value={priority}
                  onChange={(e) => {
                    setPriority(e.target.value);
                  }}
                >
                  {PRIORITY_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {t(`supportCases.priorities.${p}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('supportCases.driver')}</Label>
              <DriverCombobox value={selectedDriver} onSelect={setSelectedDriver} />
            </div>
            <div className="space-y-2">
              <Label>{t('supportCases.linkedSessions')}</Label>
              {selectedSessions.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {selectedSessions.map((s) => (
                    <span
                      key={s.id}
                      className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
                    >
                      {s.transactionId}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSessions((prev) => prev.filter((p) => p.id !== s.id));
                        }}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={sessionSearchText}
                  onChange={(e) => {
                    setSessionSearchText(e.target.value);
                  }}
                  placeholder={t('supportCases.searchSessionPlaceholder')}
                  className="pl-9"
                />
                {sessionSearchText.length >= 2 &&
                  sessionResults?.data != null &&
                  sessionResults.data.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                      {sessionResults.data
                        .filter((s) => !selectedSessions.some((sel) => sel.id === s.id))
                        .map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              setSelectedSessions((prev) => [...prev, s]);
                              setSessionSearchText('');
                            }}
                            className="block w-full text-left px-3 py-1.5 text-xs hover:bg-accent"
                          >
                            {s.transactionId}
                          </button>
                        ))}
                    </div>
                  )}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="case-assigned-to-select">{t('supportCases.assignedTo')}</Label>
              <Select
                id="case-assigned-to-select"
                value={assignedTo}
                onChange={(e) => {
                  setAssignedTo(e.target.value);
                }}
              >
                <option value="">-</option>
                {operatorUsers?.data.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.firstName} {u.lastName}
                  </option>
                ))}
              </Select>
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(createMutation.error, t)}</p>
            )}
            <div className="flex justify-end gap-2">
              <CancelButton
                onClick={() => {
                  void navigate('/support-cases');
                }}
              />
              <CreateButton
                label={t('common.create')}
                type="submit"
                disabled={createMutation.isPending}
              />
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
