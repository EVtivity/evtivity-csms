import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "InstallCertificateRequest",
  "type": "object",
  "properties": {
    "certificateType": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "CentralSystemRootCertificate",
        "ManufacturerRootCertificate"
      ]
    },
    "certificate": {
      "type": "string",
      "maxLength": 5500
    }
  },
  "additionalProperties": false,
  "required": [
    "certificateType",
    "certificate"
  ]
} as const;

export const validateInstallCertificate: ValidateFunction = ajv.compile(schema);
