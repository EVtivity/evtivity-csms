import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';

const schema = {
  "title": "BootNotificationRequest",
  "type": "object",
  "properties": {
    "chargePointVendor": {
      "type": "string",
      "maxLength": 20
    },
    "chargePointModel": {
      "type": "string",
      "maxLength": 20
    },
    "chargePointSerialNumber": {
      "type": "string",
      "maxLength": 25
    },
    "chargeBoxSerialNumber": {
      "type": "string",
      "maxLength": 25
    },
    "firmwareVersion": {
      "type": "string",
      "maxLength": 50
    },
    "iccid": {
      "type": "string",
      "maxLength": 20
    },
    "imsi": {
      "type": "string",
      "maxLength": 20
    },
    "meterType": {
      "type": "string",
      "maxLength": 25
    },
    "meterSerialNumber": {
      "type": "string",
      "maxLength": 25
    }
  },
  "additionalProperties": false,
  "required": [
    "chargePointVendor",
    "chargePointModel"
  ]
} as const;

export const validateBootNotification: ValidateFunction = ajv.compile(schema);
