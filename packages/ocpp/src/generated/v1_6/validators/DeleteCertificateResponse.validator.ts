import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DeleteCertificateResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Failed",
        "NotFound"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateDeleteCertificateResponse: ValidateFunction = ajv.compile(schema);
