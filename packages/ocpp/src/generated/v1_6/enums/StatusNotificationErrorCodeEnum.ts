export const StatusNotificationErrorCodeEnum = {
  ConnectorLockFailure: 'ConnectorLockFailure',
  EVCommunicationError: 'EVCommunicationError',
  GroundFailure: 'GroundFailure',
  HighTemperature: 'HighTemperature',
  InternalError: 'InternalError',
  LocalListConflict: 'LocalListConflict',
  NoError: 'NoError',
  OtherError: 'OtherError',
  OverCurrentFailure: 'OverCurrentFailure',
  PowerMeterFailure: 'PowerMeterFailure',
  PowerSwitchFailure: 'PowerSwitchFailure',
  ReaderFailure: 'ReaderFailure',
  ResetFailure: 'ResetFailure',
  UnderVoltage: 'UnderVoltage',
  OverVoltage: 'OverVoltage',
  WeakSignal: 'WeakSignal',
} as const;

export type StatusNotificationErrorCodeEnum = (typeof StatusNotificationErrorCodeEnum)[keyof typeof StatusNotificationErrorCodeEnum];
