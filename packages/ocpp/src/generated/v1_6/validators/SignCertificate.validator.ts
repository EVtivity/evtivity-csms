import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SignCertificateRequest",
  "type": "object",
  "properties": {
    "csr": {
      "type": "string",
      "maxLength": 5500
    }
  },
  "additionalProperties": false,
  "required": [
    "csr"
  ]
} as const;

export const validateSignCertificate: ValidateFunction = ajv.compile(schema);
