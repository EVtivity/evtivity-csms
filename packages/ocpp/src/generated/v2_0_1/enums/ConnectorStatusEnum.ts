export const ConnectorStatusEnum = {
  Available: 'Available',
  Occupied: 'Occupied',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
} as const;

export type ConnectorStatusEnum = (typeof ConnectorStatusEnum)[keyof typeof ConnectorStatusEnum];
