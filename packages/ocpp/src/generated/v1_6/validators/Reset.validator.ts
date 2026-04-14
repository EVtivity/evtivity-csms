import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ResetRequest",
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Hard",
        "Soft"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "type"
  ]
} as const;

export const validateReset: ValidateFunction = ajv.compile(schema);
