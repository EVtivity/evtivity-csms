import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetInstalledCertificateIdsResponse",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Accepted",
        "NotFound"
      ]
    },
    "certificateHashData": {
      "type": "array",
      "items": {
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
    }
  },
  "additionalProperties": false,
  "required": [
    "status"
  ]
} as const;

export const validateGetInstalledCertificateIdsResponse: ValidateFunction = ajv.compile(schema);
