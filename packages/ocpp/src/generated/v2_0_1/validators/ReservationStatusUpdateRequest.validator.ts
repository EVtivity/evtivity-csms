import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:ReservationStatusUpdateRequest",
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
    },
    "ReservationUpdateStatusEnumType": {
      "description": "The updated reservation status.\r\n",
      "javaType": "ReservationUpdateStatusEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "Expired",
        "Removed"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "reservationId": {
      "description": "The ID of the reservation.\r\n",
      "type": "integer"
    },
    "reservationUpdateStatus": {
      "$ref": "#/definitions/ReservationUpdateStatusEnumType"
    }
  },
  "required": [
    "reservationId",
    "reservationUpdateStatus"
  ]
} as const;

export const validateReservationStatusUpdateRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalReservationStatusUpdateRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateReservationStatusUpdateRequest for that.
 */
export function fitReservationStatusUpdateRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalReservationStatusUpdateRequest(copy);
  return copy;
}
