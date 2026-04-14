import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "ChangeAvailabilityResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected",
        "Scheduled"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateChangeAvailabilityResponse: ValidateFunction = ajv.compile(schema);
