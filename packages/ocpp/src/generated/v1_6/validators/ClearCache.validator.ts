import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ClearCacheRequest",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateClearCache: ValidateFunction = ajv.compile(schema);
