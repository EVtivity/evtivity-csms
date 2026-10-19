export const GetDisplayMessagesStatusEnum = {
  Accepted: 'Accepted',
  Unknown: 'Unknown',
} as const;

export type GetDisplayMessagesStatusEnum = (typeof GetDisplayMessagesStatusEnum)[keyof typeof GetDisplayMessagesStatusEnum];
