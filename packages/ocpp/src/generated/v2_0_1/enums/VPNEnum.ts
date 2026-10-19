export const VPNEnum = {
  IKEv2: 'IKEv2',
  IPSec: 'IPSec',
  L2TP: 'L2TP',
  PPTP: 'PPTP',
} as const;

export type VPNEnum = (typeof VPNEnum)[keyof typeof VPNEnum];
