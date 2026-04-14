export const DayOfWeekEnum = {
  Monday: 'Monday',
  Tuesday: 'Tuesday',
  Wednesday: 'Wednesday',
  Thursday: 'Thursday',
  Friday: 'Friday',
  Saturday: 'Saturday',
  Sunday: 'Sunday',
} as const;

export type DayOfWeekEnum = (typeof DayOfWeekEnum)[keyof typeof DayOfWeekEnum];
