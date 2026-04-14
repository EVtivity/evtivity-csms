import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SignedUpdateFirmwareResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "Rejected",
        "AcceptedCanceled",
        "InvalidCertificate",
        "RevokedCertificate"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateSignedUpdateFirmwareResponse: ValidateFunction = ajv.compile(schema);
