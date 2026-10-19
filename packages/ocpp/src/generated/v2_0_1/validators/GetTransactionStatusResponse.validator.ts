import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:GetTransactionStatusResponse",
  "comment": "OCPP 2.0.1 FINAL",
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
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "ongoingIndicator": {
      "description": "Whether the transaction is still ongoing.\r\n",
      "type": "boolean"
    },
    "messagesInQueue": {
      "description": "Whether there are still message to be delivered.\r\n",
      "type": "boolean"
    }
  },
  "required": [
    "messagesInQueue"
  ]
} as const;

export const validateGetTransactionStatusResponse: ValidateFunction = ajv.compile(schema);

const removeAdditionalGetTransactionStatusResponse: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateGetTransactionStatusResponse for that.
 */
export function fitGetTransactionStatusResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalGetTransactionStatusResponse(copy);
  return copy;
}
