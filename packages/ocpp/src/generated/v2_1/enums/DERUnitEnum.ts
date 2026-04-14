export const DERUnitEnum = {
  Not_Applicable: 'Not_Applicable',
  PctMaxW: 'PctMaxW',
  PctMaxVar: 'PctMaxVar',
  PctWAvail: 'PctWAvail',
  PctVarAvail: 'PctVarAvail',
  PctEffectiveV: 'PctEffectiveV',
} as const;

export type DERUnitEnum = (typeof DERUnitEnum)[keyof typeof DERUnitEnum];
