export const EnergyTransferModeEnum = {
  DC: 'DC',
  AC_single_phase: 'AC_single_phase',
  AC_two_phase: 'AC_two_phase',
  AC_three_phase: 'AC_three_phase',
} as const;

export type EnergyTransferModeEnum = (typeof EnergyTransferModeEnum)[keyof typeof EnergyTransferModeEnum];
