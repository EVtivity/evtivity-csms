import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetDiagnosticsResponse",
  "type": "object",
  "properties": {
    "fileName": {
      "type": "string",
      "maxLength": 255
    }
  },
  "additionalProperties": false
} as const;

export const validateGetDiagnosticsResponse: ValidateFunction = ajv.compile(schema);
