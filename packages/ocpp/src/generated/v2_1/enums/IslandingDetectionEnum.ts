export const IslandingDetectionEnum = {
  NoAntiIslandingSupport: 'NoAntiIslandingSupport',
  RoCoF: 'RoCoF',
  UVP_OVP: 'UVP_OVP',
  UFP_OFP: 'UFP_OFP',
  VoltageVectorShift: 'VoltageVectorShift',
  ZeroCrossingDetection: 'ZeroCrossingDetection',
  OtherPassive: 'OtherPassive',
  ImpedanceMeasurement: 'ImpedanceMeasurement',
  ImpedanceAtFrequency: 'ImpedanceAtFrequency',
  SlipModeFrequencyShift: 'SlipModeFrequencyShift',
  SandiaFrequencyShift: 'SandiaFrequencyShift',
  SandiaVoltageShift: 'SandiaVoltageShift',
  FrequencyJump: 'FrequencyJump',
  RCLQFactor: 'RCLQFactor',
  OtherActive: 'OtherActive',
} as const;

export type IslandingDetectionEnum = (typeof IslandingDetectionEnum)[keyof typeof IslandingDetectionEnum];
