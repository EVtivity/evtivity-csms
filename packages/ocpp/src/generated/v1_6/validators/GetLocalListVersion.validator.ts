import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetLocalListVersionRequest",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateGetLocalListVersion: ValidateFunction = ajv.compile(schema);
