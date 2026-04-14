import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DiagnosticsStatusNotificationResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateDiagnosticsStatusNotificationResponse: ValidateFunction = ajv.compile(schema);
