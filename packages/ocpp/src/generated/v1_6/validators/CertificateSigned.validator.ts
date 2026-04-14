import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "CertificateSignedRequest",
  "type": "object",
  "properties": {
    "certificateChain": {
      "type": "string",
      "maxLength": 10000
    }
  },
  "additionalProperties": false,
  "required": [
    "certificateChain"
  ]
} as const;

export const validateCertificateSigned: ValidateFunction = ajv.compile(schema);
