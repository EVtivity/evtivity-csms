import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "GetConfigurationResponse",
  "type": "object",
  "properties": {
    "configurationKey": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "maxLength": 50
          },
          "readonly": {
            "type": "boolean"
          },
          "value": {
            "type": "string",
            "maxLength": 500
          }
        },
        "additionalProperties": false,
        "required": [
          "key",
          "readonly"
        ]
      }
    },
    "unknownKey": {
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 50
      }
    }
  },
  "additionalProperties": false
} as const;

export const validateGetConfigurationResponse: ValidateFunction = ajv.compile(schema);
