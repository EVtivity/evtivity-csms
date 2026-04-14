// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

export function EvPlugAnimation(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 200 120"
      className="w-full max-w-[200px] mx-auto"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <style>
          {`
            @keyframes nudge {
              0%, 100% { transform: translateX(0); }
              50% { transform: translateX(8px); }
            }
            .plug-group { animation: nudge 1.8s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) {
              .plug-group { animation: none; }
            }
          `}
        </style>
      </defs>

      {/* Cable */}
      <g className="plug-group">
        <path
          d="M10 70 Q 30 70 40 60 Q 50 50 55 50"
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="5"
          strokeLinecap="round"
          opacity="0.6"
        />
        {/* Plug handle */}
        <rect
          x="52"
          y="38"
          width="28"
          height="24"
          rx="4"
          fill="hsl(var(--primary))"
          opacity="0.85"
        />
        {/* Plug head */}
        <rect x="78" y="34" width="18" height="32" rx="3" fill="hsl(var(--primary))" />
        {/* Plug pins */}
        <rect x="96" y="42" width="8" height="4" rx="1" fill="hsl(var(--primary))" opacity="0.9" />
        <rect x="96" y="54" width="8" height="4" rx="1" fill="hsl(var(--primary))" opacity="0.9" />
        {/* Lightning bolt on plug */}
        <path
          d="M68 44 L64 50 L68 50 L65 56"
          fill="none"
          stroke="hsl(var(--primary-foreground))"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>

      {/* Socket / Port */}
      <g>
        {/* Socket body - round */}
        <circle
          cx="155"
          cy="50"
          r="20"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="2.5"
          opacity="0.5"
        />
        {/* Socket holes - ring of 5 */}
        <circle
          cx="148"
          cy="42"
          r="3"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <circle
          cx="162"
          cy="42"
          r="3"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <circle
          cx="144"
          cy="53"
          r="3"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <circle
          cx="166"
          cy="53"
          r="3"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.5"
        />
        <circle
          cx="155"
          cy="60"
          r="3"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.5"
        />
        {/* Center pin hole */}
        <circle
          cx="155"
          cy="49"
          r="2"
          fill="none"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="1.5"
          opacity="0.4"
        />
      </g>

      {/* Arrow hint */}
      <path
        d="M115 80 L125 80 L121 76 M125 80 L121 84"
        fill="none"
        stroke="hsl(var(--muted-foreground))"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.4"
      />
    </svg>
  );
}
