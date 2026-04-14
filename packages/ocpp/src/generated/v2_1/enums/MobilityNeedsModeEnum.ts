export const MobilityNeedsModeEnum = {
  EVCC: 'EVCC',
  EVCC_SECC: 'EVCC_SECC',
} as const;

export type MobilityNeedsModeEnum = (typeof MobilityNeedsModeEnum)[keyof typeof MobilityNeedsModeEnum];
