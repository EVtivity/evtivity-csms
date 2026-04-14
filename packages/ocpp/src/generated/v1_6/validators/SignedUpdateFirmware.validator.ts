import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "SignedUpdateFirmwareRequest",
  "type": "object",
  "properties": {
    "requestId": {
      "type": "integer"
    },
    "retries": {
      "type": "integer"
    },
    "retryInterval": {
      "type": "integer"
    },
    "firmware": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "maxLength": 512
        },
        "retrieveDateTime": {
          "type": "string",
          "format": "date-time"
        },
        "installDateTime": {
          "type": "string",
          "format": "date-time"
        },
        "signingCertificate": {
          "type": "string",
          "maxLength": 5500
        },
        "signature": {
          "type": "string",
          "maxLength": 800
        }
      },
      "additionalProperties": false,
      "required": [
        "location",
        "retrieveDateTime",
        "signingCertificate",
        "signature"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "requestId",
    "firmware"
  ]
} as const;

export const validateSignedUpdateFirmware: ValidateFunction = ajv.compile(schema);
