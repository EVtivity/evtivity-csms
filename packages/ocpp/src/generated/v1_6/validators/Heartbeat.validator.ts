import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "HeartbeatRequest",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateHeartbeat: ValidateFunction = ajv.compile(schema);
