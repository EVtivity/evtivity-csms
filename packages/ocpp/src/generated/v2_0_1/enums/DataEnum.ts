export const DataEnum = {
  string: 'string',
  decimal: 'decimal',
  integer: 'integer',
  dateTime: 'dateTime',
  boolean: 'boolean',
  OptionList: 'OptionList',
  SequenceList: 'SequenceList',
  MemberList: 'MemberList',
} as const;

export type DataEnum = (typeof DataEnum)[keyof typeof DataEnum];
