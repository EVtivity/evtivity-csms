// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// The fresh proof of the account a bus depot system change takes from a
// signed-in session (create, a new password, turning it on, a depot change,
// delete), in the pattern of the other settings that take one.

import { useState } from 'react';
import {
  FactorProofField,
  proofRejection,
  type FactorProof,
  type ProofRejection,
} from '@/components/FactorProofField';
import { useMfaStatus } from '@/components/profile/mfa-status';

export interface ProofStep {
  /** The account has a proof kind, so the change takes a proof. */
  needed: boolean;
  proof: FactorProof | null;
  /** Starts a new proof (a new dialog or a new attempt). */
  reset: () => void;
  /** Checks a proof is given; otherwise marks it missing and answers false. */
  ready: () => boolean;
  /** Records a failed call that carried the proof. */
  failed: (err: unknown) => void;
  /** The proof field, or null when the account has no proof kind. */
  field: (idPrefix: string, description: string) => React.JSX.Element | null;
}

export function useProofStep(): ProofStep {
  const { data: mfaStatus } = useMfaStatus();
  const kinds = mfaStatus?.factorProofKinds ?? [];
  const [proof, setProof] = useState<FactorProof | null>(null);
  const [failure, setFailure] = useState<ProofRejection | null>(null);
  const [asked, setAsked] = useState(false);
  const [round, setRound] = useState(0);
  const needed = kinds.length > 0;
  return {
    needed,
    proof,
    reset: () => {
      setProof(null);
      setFailure(null);
      setAsked(false);
      setRound((n) => n + 1);
    },
    ready: () => {
      if (needed && proof == null) {
        setAsked(true);
        return false;
      }
      return true;
    },
    failed: (err: unknown) => {
      setFailure(proofRejection(err));
    },
    field: (idPrefix: string, description: string) =>
      needed ? (
        <FactorProofField
          key={`${idPrefix}-${String(round)}`}
          idPrefix={idPrefix}
          kinds={kinds}
          codeMethod={mfaStatus?.mfaMethod ?? null}
          description={description}
          onChange={setProof}
          rejection={failure}
          showMissing={asked}
        />
      ) : null,
  };
}

/** The `proof` part of a request body. */
export function proofBody(step: ProofStep): { proof?: FactorProof } {
  return step.needed && step.proof != null ? { proof: step.proof } : {};
}
