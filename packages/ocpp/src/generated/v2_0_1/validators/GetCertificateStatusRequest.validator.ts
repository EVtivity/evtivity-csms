import type { ValidateFunction } from 'ajv';
import { ajv } from './_ajv.js';
import { ajvFit } from './_ajv-fit.js';

const schema = {
  "$id": "urn:OCPP:Cp:2:2020:3:GetCertificateStatusRequest",
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
    "HashAlgorithmEnumType": {
      "description": "Used algorithms for the hashes provided.\r\n",
      "javaType": "HashAlgorithmEnum",
      "type": "string",
      "additionalProperties": false,
      "enum": [
        "SHA256",
        "SHA384",
        "SHA512"
      ]
    },
    "OCSPRequestDataType": {
      "javaType": "OCSPRequestData",
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "customData": {
          "$ref": "#/definitions/CustomDataType"
        },
        "hashAlgorithm": {
          "$ref": "#/definitions/HashAlgorithmEnumType"
        },
        "issuerNameHash": {
          "description": "Hashed value of the Issuer DN (Distinguished Name).\r\n\r\n",
          "type": "string",
          "maxLength": 128
        },
        "issuerKeyHash": {
          "description": "Hashed value of the issuers public key\r\n",
          "type": "string",
          "maxLength": 128
        },
        "serialNumber": {
          "description": "The serial number of the certificate.\r\n",
          "type": "string",
          "maxLength": 40
        },
        "responderURL": {
          "description": "This contains the responder URL (Case insensitive). \r\n\r\n",
          "type": "string",
          "maxLength": 512
        }
      },
      "required": [
        "hashAlgorithm",
        "issuerNameHash",
        "issuerKeyHash",
        "serialNumber",
        "responderURL"
      ]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "customData": {
      "$ref": "#/definitions/CustomDataType"
    },
    "ocspRequestData": {
      "$ref": "#/definitions/OCSPRequestDataType"
    }
  },
  "required": [
    "ocspRequestData"
  ]
} as const;

export const validateGetCertificateStatusRequest: ValidateFunction = ajv.compile(schema);

const removeAdditionalGetCertificateStatusRequest: ValidateFunction = ajvFit.compile(schema);

/**
 * Returns a deep copy of the payload without the properties this schema does not allow.
 * The input is not changed. The copy is not validated: call validateGetCertificateStatusRequest for that.
 */
export function fitGetCertificateStatusRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  removeAdditionalGetCertificateStatusRequest(copy);
  return copy;
}
