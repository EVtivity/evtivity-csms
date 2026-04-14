import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "MeterValuesResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateMeterValuesResponse: ValidateFunction = ajv.compile(schema);
