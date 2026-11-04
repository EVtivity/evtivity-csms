// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { CreateButton } from '@/components/create-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message';
import {
  DepotSystemFields,
  depotSystemFormErrors,
  depotTimingsBody,
  emptyDepotSystemForm,
  type DepotSystemFormValues,
} from './DepotSystemFields';
import { DEPOT_SYSTEMS_KEY, type DepotSystemWithPassword } from './depot-system-types';
import { proofBody, useProofStep } from './use-proof-step';

/**
 * Creates a bus depot system (turned off; it is turned on from its page) and
 * hands the answer, with the password shown once, to `onCreated`.
 */
export function DepotSystemCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: DepotSystemWithPassword) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] md:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('depotSystems.create')}</DialogTitle>
          <DialogDescription>{t('depotSystems.createDescription')}</DialogDescription>
        </DialogHeader>
        {open && (
          <CreateForm
            onCancel={() => {
              onOpenChange(false);
            }}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (created: DepotSystemWithPassword) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proof = useProofStep();
  const [values, setValues] = useState<DepotSystemFormValues>(emptyDepotSystemForm());
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const errors = depotSystemFormErrors(values, t, true);

  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<DepotSystemWithPassword>('/v1/depot-systems', body),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: DEPOT_SYSTEMS_KEY });
      onCreated(created);
    },
    onError: (err: unknown) => {
      proof.failed(err);
    },
  });

  function handleSubmit(e: React.SyntheticEvent): void {
    e.preventDefault();
    setHasSubmitted(true);
    if (Object.keys(errors).length > 0 || !proof.ready()) return;
    mutation.mutate({
      presystemId: values.presystemId.trim(),
      name: values.name.trim(),
      systemType: values.systemType,
      siteIds: values.siteIds,
      ...depotTimingsBody(values),
      ...proofBody(proof),
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4">
      <DepotSystemFields
        idPrefix="depot-create"
        values={values}
        onChange={(next) => {
          setValues(next);
          mutation.reset();
        }}
        errors={hasSubmitted ? errors : {}}
        creating
      />
      {proof.field('depot-create-proof', t('depotSystems.proofHint'))}
      {mutation.isError && (
        <p className="text-sm text-destructive" role="alert">
          {getErrorMessage(mutation.error, t)}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <CreateButton
          type="submit"
          label={t('depotSystems.create')}
          disabled={mutation.isPending}
        />
      </DialogFooter>
    </form>
  );
}
