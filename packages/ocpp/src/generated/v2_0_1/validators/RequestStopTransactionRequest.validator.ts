import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:RequestStopTransactionRequest",
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
    "transactionId": {
      "description": "The identifier of the transaction which the Charging Station is requested to stop.\r\n",
      "type": "string",
      "maxLength": 36
    }
  },
  "required": [
    "transactionId"
  ]
} as const;

export const validateRequestStopTransactionRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalRequestStopTransactionRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateRequestStopTransactionRequest for that.
 */
export function fitRequestStopTransactionRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalRequestStopTransactionRequest(copy);
  return copy;
}
