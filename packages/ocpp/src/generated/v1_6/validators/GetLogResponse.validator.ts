import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetLogResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected",
        "AcceptedCanceled"
      ]
    },
    "filename": {
      "type": "string",
      "maxLength": 255
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateGetLogResponse: ValidateFunction = ajv.compile(schema);
