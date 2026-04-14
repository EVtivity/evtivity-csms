import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetInstalledCertificateIdsRequest",
  "type": "object",
  "properties": {
    "certificateType": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "CentralSystemRootCertificate",
        "ManufacturerRootCertificate"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "certificateType"
  ]
} as const;

export const validateGetInstalledCertificateIds: ValidateFunction = ajv.compile(schema);
