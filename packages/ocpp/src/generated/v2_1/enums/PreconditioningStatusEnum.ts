export const PreconditioningStatusEnum = {
  Unknown: 'Unknown',
  Ready: 'Ready',
  NotReady: 'NotReady',
  Preconditioning: 'Preconditioning',
} as const;

export type PreconditioningStatusEnum = (typeof PreconditioningStatusEnum)[keyof typeof PreconditioningStatusEnum];
