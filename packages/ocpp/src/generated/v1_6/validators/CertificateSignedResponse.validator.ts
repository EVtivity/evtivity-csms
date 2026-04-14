import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "CertificateSignedResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateCertificateSignedResponse: ValidateFunction = ajv.compile(schema);
