export const StopTransactionUnitEnum = {
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

export type StopTransactionUnitEnum = (typeof StopTransactionUnitEnum)[keyof typeof StopTransactionUnitEnum];
