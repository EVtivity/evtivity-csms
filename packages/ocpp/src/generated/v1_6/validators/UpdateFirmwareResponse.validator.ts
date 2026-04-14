import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "UpdateFirmwareResponse",
  "type": "object",
  "properties": {},
  "additionalProperties": false
} as const;

export const validateUpdateFirmwareResponse: ValidateFunction = ajv.compile(schema);
