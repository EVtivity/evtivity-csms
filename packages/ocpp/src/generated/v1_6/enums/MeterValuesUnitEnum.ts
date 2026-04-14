export const MeterValuesUnitEnum = {
  Wh: 'Wh',
  kWh: 'kWh',
  varh: 'varh',
  kvarh: 'kvarh',
  W: 'W',
  kW: 'kW',
  VA: 'VA',
  kVA: 'kVA',
  var: 'var',
  kvar: 'kvar',
  A: 'A',
  V: 'V',
  K: 'K',
  Celcius: 'Celcius',
  Celsius: 'Celsius',
  Fahrenheit: 'Fahrenheit',
  Percent: 'Percent',
} as const;

export type MeterValuesUnitEnum = (typeof MeterValuesUnitEnum)[keyof typeof MeterValuesUnitEnum];
