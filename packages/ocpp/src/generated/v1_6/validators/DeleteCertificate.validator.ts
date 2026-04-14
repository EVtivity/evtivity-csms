import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "DeleteCertificateRequest",
  "type": "object",
  "properties": {
    "certificateHashData": {
      "type": "object",
      "properties": {
        "hashAlgorithm": {
          "type": "string",
          "additionalProperties": false,
          "enum": [
            "SHA256",
            "SHA384",
            "SHA512"
          ]
        },
        "issuerNameHash": {
          "type": "string",
          "maxLength": 128
        },
        "issuerKeyHash": {
          "type": "string",
          "maxLength": 128
        },
        "serialNumber": {
          "type": "string",
          "maxLength": 40
        }
      },
      "additionalProperties": false,
      "required": [
        "hashAlgorithm",
        "issuerNameHash",
        "issuerKeyHash",
        "serialNumber"
      ]
    }
  },
  "additionalProperties": false,
  "required": [
    "certificateHashData"
  ]
} as const;

export const validateDeleteCertificate: ValidateFunction = ajv.compile(schema);
