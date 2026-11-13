// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import { useTranslation } from 'react-i18next';
import {
  CONNECTOR_FACES,
  faceDrawing,
  knownConnectorKind,
  r3,
  type ConnectorKind,
} from '@evtivity/lib/connector-faces';
import { useReducedMotion } from '@/hooks/use-reduced-motion';

// The plug-in step (owner decision 2026-11-12): a generic charging handle
// with its cable moves to the car's charge port, plugs in, and the port light
// turns on, in a gentle loop. The inlet shows the measured face of the EVSE's
// connector type, from the same geometry as the CSMS 2D charger cards
// (@evtivity/lib/connector-faces); an unknown type shows a neutral round
// inlet. Colors are theme tokens. With reduced motion the still frame shows
// the handle plugged in and the light on.

/** Where the 16-unit face pictogram sits in the inlet, and its scale. */
const FACE_X = 132;
const FACE_Y = 66;
const FACE_SIZE = 28;
const FACE_SCALE = FACE_SIZE / 16;

function InletFace({ kind }: { kind: ConnectorKind | null }): React.JSX.Element {
  const stroke = 'hsl(var(--muted-foreground))';
  if (kind == null) {
    return (
      <circle
        data-testid="ev-plug-face"
        data-connector="neutral"
        cx={FACE_X + FACE_SIZE / 2}
        cy={FACE_Y + FACE_SIZE / 2}
        r={FACE_SIZE / 2 - 2}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
      />
    );
  }
  const d = faceDrawing(CONNECTOR_FACES[kind], 48);
  return (
    <g
      data-testid="ev-plug-face"
      data-connector={kind}
      transform={`translate(${String(FACE_X)} ${String(FACE_Y)}) scale(${String(FACE_SCALE)})`}
    >
      <path
        d={d.outline}
        fill="none"
        stroke={stroke}
        strokeWidth={d.stroke}
        strokeLinejoin="round"
      />
      {d.contacts.map((c) =>
        c.ring ? (
          <circle
            key={c.name}
            cx={r3(c.cx)}
            cy={r3(c.cy)}
            r={r3(c.r)}
            fill="none"
            stroke={stroke}
            strokeWidth={r3(c.stroke)}
          />
        ) : (
          <circle key={c.name} cx={r3(c.cx)} cy={r3(c.cy)} r={r3(c.r)} fill={stroke} />
        ),
      )}
    </g>
  );
}

export function EvPlugAnimation({
  connectorType,
}: {
  /** The EVSE's connector type as the station reports it; null or unknown shows a neutral inlet. */
  connectorType?: string | null | undefined;
}): React.JSX.Element {
  const { t } = useTranslation();
  const still = useReducedMotion();
  const kind = knownConnectorKind(connectorType);
  return (
    <svg
      role="img"
      aria-label={t('charger.plugInAnimationLabel')}
      viewBox="0 0 260 130"
      className="mx-auto w-full max-w-[260px]"
      data-testid="ev-plug-animation"
      data-motion={still ? 'still' : 'loop'}
    >
      <title>{t('charger.plugInAnimationLabel')}</title>

      {/* The car's rear quarter, its rear facing left: body, rear window,
          door line, taillight and wheel */}
      <path
        d="M110 112 L110 80 C110 66 118 58 132 55 L176 48 C188 30 206 22 230 20 L260 20 L260 112 Z"
        fill="hsl(var(--muted))"
        stroke="hsl(var(--border))"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path
        d="M184 46 C193 33 208 27 228 26 L256 26 L256 46 Z"
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth={1.2}
      />
      <path d="M178 50 L178 106" stroke="hsl(var(--border))" strokeWidth={1.2} />
      <rect
        x={110}
        y={80}
        width={5}
        height={14}
        rx={2}
        fill="hsl(var(--destructive))"
        opacity={0.7}
      />
      <circle cx={204} cy={114} r={22} fill="hsl(var(--card))" />
      <circle cx={204} cy={114} r={18} fill="hsl(var(--foreground))" opacity={0.75} />
      <circle cx={204} cy={114} r={8} fill="hsl(var(--muted-foreground))" />

      {/* The charge port: its light ring, the recess and the inlet face */}
      <rect
        x={124}
        y={58}
        width={44}
        height={44}
        rx={11}
        fill="none"
        stroke="hsl(var(--success))"
        strokeWidth={3}
        className={still ? undefined : 'ev-plug-light'}
        opacity={still ? 1 : undefined}
        data-testid="ev-plug-light"
      />
      <rect
        x={128}
        y={62}
        width={36}
        height={36}
        rx={8}
        fill="hsl(var(--card))"
        stroke="hsl(var(--border))"
        strokeWidth={1.5}
      />
      <InletFace kind={kind} />

      {/* The charging handle and its cable, drawn plugged in */}
      <g className={still ? undefined : 'ev-plug-handle'} data-testid="ev-plug-handle">
        <path
          d="M66 126 C46 140 20 116 -10 124"
          fill="none"
          stroke="hsl(var(--foreground))"
          strokeWidth={7}
          strokeLinecap="round"
          opacity={0.7}
        />
        <path
          d="M72 120 L62 130"
          stroke="hsl(var(--foreground))"
          strokeWidth={10}
          strokeLinecap="round"
          opacity={0.8}
        />
        <path
          d="M96 88 L70 116 Q72 125 82 123 L110 95 Z"
          fill="hsl(var(--primary))"
          opacity={0.9}
        />
        <path
          d="M140 64 L104 64 C96 64 92 70 92 78 L92 82 C92 90 98 96 106 96 L140 96 Z"
          fill="hsl(var(--primary))"
        />
        <rect x={136} y={69} width={24} height={22} rx={5} fill="hsl(var(--primary))" />
        <path
          d="M100 64 Q118 54 136 64"
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <path
          d="M118 70 L112 80 L118 80 L113 90"
          fill="none"
          stroke="hsl(var(--primary-foreground))"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
