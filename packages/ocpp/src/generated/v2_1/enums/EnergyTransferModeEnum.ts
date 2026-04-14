export const EnergyTransferModeEnum = {
  AC_single_phase: 'AC_single_phase',
  AC_two_phase: 'AC_two_phase',
  AC_three_phase: 'AC_three_phase',
  DC: 'DC',
  AC_BPT: 'AC_BPT',
  AC_BPT_DER: 'AC_BPT_DER',
  AC_DER: 'AC_DER',
  DC_BPT: 'DC_BPT',
  DC_ACDP: 'DC_ACDP',
  DC_ACDP_BPT: 'DC_ACDP_BPT',
  WPT: 'WPT',
} as const;

export type EnergyTransferModeEnum = (typeof EnergyTransferModeEnum)[keyof typeof EnergyTransferModeEnum];
