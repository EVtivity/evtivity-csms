export const DisplayMessageStatusEnum = {
  Accepted: 'Accepted',
  NotSupportedMessageFormat: 'NotSupportedMessageFormat',
  Rejected: 'Rejected',
  NotSupportedPriority: 'NotSupportedPriority',
  NotSupportedState: 'NotSupportedState',
  UnknownTransaction: 'UnknownTransaction',
  LanguageNotSupported: 'LanguageNotSupported',
} as const;

export type DisplayMessageStatusEnum = (typeof DisplayMessageStatusEnum)[keyof typeof DisplayMessageStatusEnum];
