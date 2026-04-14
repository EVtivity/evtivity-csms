import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2025:1:GetTransactionStatusRequest",
  "comment": "OCPP 2.1 Edition 1 (c) OCA, Creative Commons Attribution-NoDerivatives 4.0 International Public License",
  "definitions": {
    "CustomDataType": {
      "description": "This class does not get 'AdditionalProperties = false' in the schema generation, so it can be extended with arbitrary JSON properties to allow adding custom data.",
      "javaType": "CustomData",
      "type": "object",
      "properties": {
        "vendorId": {
          "type": "string",
          "maxLength": 255
        }
      },
      "required": [
        "vendorId"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "transactionId": {
      "description": "The Id of the transaction for which the status is requested.\r\n",
      "type": "string",
      "maxLength": 36
    },
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    }
  }
} as const;

export const validateGetTransactionStatusRequest: ValidateFunction = ajv.compile(schema);
