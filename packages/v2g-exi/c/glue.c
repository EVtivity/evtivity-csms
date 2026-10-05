// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Glue between the EVerest libcbv2g EXI codec and JavaScript for the ISO
// 15118 certificate installation and update messages:
//
//   ISO 15118-2  (urn:iso:15118:2:2013:MsgDef): V2G_Message with
//                CertificateInstallationReq/Res or CertificateUpdateReq/Res
//   ISO 15118-20 (urn:iso:std:iso:15118:-20:CommonMessages):
//                CertificateInstallationReq/Res
//
// Decoding returns JSON. Encoding takes a tag-length-value record (see
// tags below) and returns JSON with the encoded message, the EXI fragment
// encoding of every element a signature can reference, and the EXI encoding
// of SignedInfo. Digests and signatures are computed in JavaScript.

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cbv2g/common/exi_bitstream.h"
#include "cbv2g/common/exi_basetypes.h"
#include "cbv2g/common/exi_error_codes.h"
#include "cbv2g/common/exi_header.h"
#include "cbv2g/iso_2/iso2_msgDefDatatypes.h"
#include "cbv2g/iso_2/iso2_msgDefDecoder.h"
#include "cbv2g/iso_2/iso2_msgDefEncoder.h"
#include "cbv2g/iso_20/iso20_CommonMessages_Datatypes.h"
#include "cbv2g/iso_20/iso20_CommonMessages_Decoder.h"

// The ISO 15118-20 fragment grammar has no entry for
// OEMProvisioningCertificateChain, the element the CertificateInstallationReq
// signature references. The encoder translation unit is included here so the
// glue can call its static SignedCertificateChainType encoder (fragment event
// 128 of 282, 9 bits, like the generated fragment encoder).
#include "lib/cbv2g/iso_20/iso20_CommonMessages_Encoder.c"

#define V2G_EXI_MAX 16384

// Errors returned by the exported functions, besides libcbv2g's negative
// EXI_ERROR__* codes.
#define GLUE_ERR_OOM -1001
#define GLUE_ERR_RECORD -1002
#define GLUE_ERR_UNSUPPORTED_MESSAGE -1003
#define GLUE_ERR_SCHEMA -1004
#define GLUE_ERR_TOO_LARGE -1005

// Record tags (1 byte tag, 4 byte big-endian length, value).
enum {
  T_MSG_TYPE = 1,         // u32: 1 InstallReq, 2 UpdateReq, 3 InstallRes, 4 UpdateRes
  T_SESSION_ID = 2,       // bytes
  T_TIMESTAMP = 3,        // 8 bytes big-endian (ISO 15118-20)
  T_SIG_REF_URI = 10,     // string, one per reference
  T_SIG_REF_DIGEST = 11,  // bytes, follows its URI
  T_SIG_METHOD = 12,      // string
  T_SIG_DIGEST_METHOD = 13, // string
  T_SIG_VALUE = 14,       // bytes
  T_BODY_ID = 20,         // string, Id of the ISO 15118-2 request
  T_OEM_CERT = 21,        // bytes
  T_OEM_SUBCERT = 22,     // bytes, repeated (ISO 15118-20)
  T_OEM_CHAIN_ID = 23,    // string (ISO 15118-20)
  T_ROOT_ISSUER = 24,     // string, one per root certificate ID
  T_ROOT_SERIAL = 25,     // bytes, unsigned big-endian, follows its issuer
  T_MAX_CHAINS = 26,      // u32 (ISO 15118-20)
  T_PRIORITIZED_EMAID = 27, // string, repeated (ISO 15118-20)
  T_RESPONSE_CODE = 30,   // u32 enum value
  T_SA_CERT = 31,         // bytes
  T_SA_SUBCERT = 32,      // bytes, repeated
  T_CONTRACT_CHAIN_ID = 33, // string
  T_CONTRACT_CERT = 34,   // bytes
  T_CONTRACT_SUBCERT = 35, // bytes, repeated
  T_ENC_KEY_ID = 36,      // string
  T_ENC_KEY = 37,         // bytes
  T_DH_ID = 38,           // string
  T_DH_KEY = 39,          // bytes
  T_EMAID_ID = 40,        // string
  T_EMAID = 41,           // string
  T_RETRY_COUNTER = 42,   // u32 (two's complement int16)
  T_SIGNED_DATA_ID = 43,  // string (ISO 15118-20)
  T_ECDH_CURVE = 44,      // u32 enum value (ISO 15118-20)
  T_REMAINING = 45,       // u32 (ISO 15118-20)
  T_EVSE_PROCESSING = 46, // u32 enum value (ISO 15118-20)
  T_ENC_KEY_KIND = 47     // u32: 0 SECP521, 1 X448, 2 TPM (ISO 15118-20)
};

// ---------------------------------------------------------------- output

static char* out_buf = NULL;
static size_t out_len = 0;
static size_t out_cap = 0;
static int out_oom = 0;

static void out_reset(void) {
  out_len = 0;
  out_oom = 0;
}

static void out_raw(const char* data, size_t len) {
  if (out_oom) return;
  if (out_len + len + 1 > out_cap) {
    size_t cap = out_cap == 0 ? 65536 : out_cap;
    while (out_len + len + 1 > cap) cap *= 2;
    char* grown = (char*)realloc(out_buf, cap);
    if (grown == NULL) {
      out_oom = 1;
      return;
    }
    out_buf = grown;
    out_cap = cap;
  }
  memcpy(out_buf + out_len, data, len);
  out_len += len;
  out_buf[out_len] = '\0';
}

static void out_str(const char* s) { out_raw(s, strlen(s)); }

static void out_uint(uint64_t v) {
  char tmp[24];
  int i = 23;
  tmp[i] = '\0';
  do {
    tmp[--i] = (char)('0' + (v % 10));
    v /= 10;
  } while (v > 0);
  out_str(&tmp[i]);
}

static void out_int(int64_t v) {
  if (v < 0) {
    out_raw("-", 1);
    out_uint((uint64_t)(-(v + 1)) + 1);
  } else {
    out_uint((uint64_t)v);
  }
}

static void out_json_string(const char* s, size_t len) {
  static const char hex[] = "0123456789abcdef";
  out_raw("\"", 1);
  for (size_t i = 0; i < len; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') {
      char esc[2] = {'\\', (char)c};
      out_raw(esc, 2);
    } else if (c < 0x20 || c >= 0x7f) {
      char esc[6] = {'\\', 'u', '0', '0', hex[c >> 4], hex[c & 0xf]};
      out_raw(esc, 6);
    } else {
      out_raw((const char*)&c, 1);
    }
  }
  out_raw("\"", 1);
}

static void out_b64(const uint8_t* data, size_t len) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  out_raw("\"", 1);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t n = (uint32_t)data[i] << 16;
    if (i + 1 < len) n |= (uint32_t)data[i + 1] << 8;
    if (i + 2 < len) n |= data[i + 2];
    char quad[4];
    quad[0] = alphabet[(n >> 18) & 63];
    quad[1] = alphabet[(n >> 12) & 63];
    quad[2] = i + 1 < len ? alphabet[(n >> 6) & 63] : '=';
    quad[3] = i + 2 < len ? alphabet[n & 63] : '=';
    out_raw(quad, 4);
  }
  out_raw("\"", 1);
}

static void out_hex(const uint8_t* data, size_t len) {
  static const char hex[] = "0123456789abcdef";
  out_raw("\"", 1);
  for (size_t i = 0; i < len; i++) {
    char pair[2] = {hex[data[i] >> 4], hex[data[i] & 0xf]};
    out_raw(pair, 2);
  }
  out_raw("\"", 1);
}

static void out_key(const char* key) {
  out_json_string(key, strlen(key));
  out_raw(":", 1);
}

static int out_finish(void) {
  if (out_oom) return GLUE_ERR_OOM;
  if (out_len > 0x7fffffff) return GLUE_ERR_TOO_LARGE;
  return (int)out_len;
}

// ---------------------------------------------------------------- exports

__attribute__((export_name("v2g_malloc"))) void* v2g_malloc(uint32_t size) { return malloc(size); }

__attribute__((export_name("v2g_free"))) void v2g_free(void* ptr) { free(ptr); }

__attribute__((export_name("v2g_result_ptr"))) const char* v2g_result_ptr(void) { return out_buf; }

// ---------------------------------------------------------------- helpers

static uint8_t* scratch = NULL;

static uint8_t* scratch_buf(void) {
  if (scratch == NULL) scratch = (uint8_t*)malloc(V2G_EXI_MAX);
  return scratch;
}

static void serial_from_exi(const exi_signed_t* value, uint8_t* bytes, size_t* len) {
  size_t n = 0;
  if (exi_basetypes_convert_bytes_from_unsigned(&value->data, bytes, &n, 32) != 0) n = 0;
  *len = n;
}

// ---------------------------------------------------------------- record

typedef struct {
  uint8_t tag;
  uint32_t len;
  const uint8_t* value;
} field_t;

typedef struct {
  const uint8_t* data;
  uint32_t len;
  uint32_t pos;
} reader_t;

static int next_field(reader_t* r, field_t* f) {
  if (r->pos == r->len) return 0;
  if (r->len - r->pos < 5) return GLUE_ERR_RECORD;
  f->tag = r->data[r->pos];
  f->len = ((uint32_t)r->data[r->pos + 1] << 24) | ((uint32_t)r->data[r->pos + 2] << 16) |
           ((uint32_t)r->data[r->pos + 3] << 8) | r->data[r->pos + 4];
  r->pos += 5;
  if (r->len - r->pos < f->len) return GLUE_ERR_RECORD;
  f->value = r->data + r->pos;
  r->pos += f->len;
  return 1;
}

static uint32_t field_u32(const field_t* f) {
  uint32_t v = 0;
  for (uint32_t i = 0; i < f->len && i < 4; i++) v = (v << 8) | f->value[i];
  return v;
}

static uint64_t field_u64(const field_t* f) {
  uint64_t v = 0;
  for (uint32_t i = 0; i < f->len && i < 8; i++) v = (v << 8) | f->value[i];
  return v;
}

#define COPY_CHARS(dst, f, cap)                                     \
  do {                                                              \
    if ((f)->len >= (cap)) return EXI_ERROR__CHARACTER_BUFFER_TOO_SMALL; \
    memcpy((dst).characters, (f)->value, (f)->len);                 \
    (dst).characters[(f)->len] = '\0';                              \
    (dst).charactersLen = (uint16_t)(f)->len;                       \
  } while (0)

#define COPY_BYTES(dst, f, cap)                                  \
  do {                                                           \
    if ((f)->len > (cap)) return EXI_ERROR__BYTE_BUFFER_TOO_SMALL; \
    memcpy((dst).bytes, (f)->value, (f)->len);                   \
    (dst).bytesLen = (uint16_t)(f)->len;                         \
  } while (0)

static void set_chars(char* dst, uint16_t* dst_len, const char* s) {
  size_t n = strlen(s);
  memcpy(dst, s, n + 1);
  *dst_len = (uint16_t)n;
}

static const char* CANONICAL_EXI = "http://www.w3.org/TR/canonical-exi/";

// ================================================================ ISO 15118-2

static void iso2_out_chain(const struct iso2_CertificateChainType* chain) {
  out_raw("{", 1);
  if (chain->Id_isUsed) {
    out_key("id");
    out_json_string(chain->Id.characters, chain->Id.charactersLen);
    out_raw(",", 1);
  }
  out_key("certificate");
  out_b64(chain->Certificate.bytes, chain->Certificate.bytesLen);
  out_raw(",", 1);
  out_key("subCertificates");
  out_raw("[", 1);
  if (chain->SubCertificates_isUsed) {
    for (uint16_t i = 0; i < chain->SubCertificates.Certificate.arrayLen; i++) {
      if (i > 0) out_raw(",", 1);
      out_b64(chain->SubCertificates.Certificate.array[i].bytes,
              chain->SubCertificates.Certificate.array[i].bytesLen);
    }
  }
  out_raw("]}", 2);
}

static void iso2_out_root_ids(const struct iso2_ListOfRootCertificateIDsType* list) {
  out_key("rootCertificateIds");
  out_raw("[", 1);
  for (uint16_t i = 0; i < list->RootCertificateID.arrayLen; i++) {
    const struct iso2_X509IssuerSerialType* id = &list->RootCertificateID.array[i];
    uint8_t serial[32];
    size_t serial_len = 0;
    serial_from_exi(&id->X509SerialNumber, serial, &serial_len);
    if (i > 0) out_raw(",", 1);
    out_raw("{", 1);
    out_key("issuerName");
    out_json_string(id->X509IssuerName.characters, id->X509IssuerName.charactersLen);
    out_raw(",", 1);
    out_key("serialNumber");
    out_hex(serial, serial_len);
    out_raw("}", 1);
  }
  out_raw("]", 1);
}

// EXI fragment encoding of one signable element, written as "id":"base64".
static int iso2_out_fragment(const char* id, size_t id_len, struct iso2_exiFragment* frag,
                             int* first) {
  uint8_t* buf = scratch_buf();
  if (buf == NULL) return GLUE_ERR_OOM;
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, buf, V2G_EXI_MAX, 0, NULL);
  int err = encode_iso2_exiFragment(&stream, frag);
  if (err != 0) return err;
  if (!*first) out_raw(",", 1);
  *first = 0;
  out_json_string(id, id_len);
  out_raw(":", 1);
  out_b64(buf, exi_bitstream_get_length(&stream));
  return 0;
}

// SignedInfo as an xmldsig fragment, the bytes ISO 15118-2 signs. Fields
// [V2G2-771] excludes are cleared, as the EVerest SECC does.
static int iso2_out_signed_info(const struct iso2_SignedInfoType* signed_info) {
  struct iso2_xmldsigFragment* frag =
      (struct iso2_xmldsigFragment*)calloc(1, sizeof(struct iso2_xmldsigFragment));
  if (frag == NULL) return GLUE_ERR_OOM;
  init_iso2_xmldsigFragment(frag);
  frag->SignedInfo_isUsed = 1;
  frag->SignedInfo = *signed_info;
  frag->SignedInfo.Id_isUsed = 0;
  frag->SignedInfo.CanonicalizationMethod.ANY_isUsed = 0;
  frag->SignedInfo.SignatureMethod.HMACOutputLength_isUsed = 0;
  frag->SignedInfo.SignatureMethod.ANY_isUsed = 0;
  for (uint16_t i = 0; i < frag->SignedInfo.Reference.arrayLen; i++) {
    struct iso2_ReferenceType* ref = &frag->SignedInfo.Reference.array[i];
    ref->Type_isUsed = 0;
    ref->Transforms.Transform.ANY_isUsed = 0;
    ref->Transforms.Transform.XPath_isUsed = 0;
    ref->DigestMethod.ANY_isUsed = 0;
  }
  uint8_t* buf = scratch_buf();
  if (buf == NULL) {
    free(frag);
    return GLUE_ERR_OOM;
  }
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, buf, V2G_EXI_MAX, 0, NULL);
  int err = encode_iso2_xmldsigFragment(&stream, frag);
  free(frag);
  if (err != 0) return err;
  out_b64(buf, exi_bitstream_get_length(&stream));
  return 0;
}

static int iso2_out_signature(const struct iso2_MessageHeaderType* header) {
  out_key("signature");
  if (!header->Signature_isUsed) {
    out_str("null");
    return 0;
  }
  const struct iso2_SignatureType* sig = &header->Signature;
  out_raw("{", 1);
  out_key("canonicalizationMethod");
  out_json_string(sig->SignedInfo.CanonicalizationMethod.Algorithm.characters,
                  sig->SignedInfo.CanonicalizationMethod.Algorithm.charactersLen);
  out_raw(",", 1);
  out_key("signatureMethod");
  out_json_string(sig->SignedInfo.SignatureMethod.Algorithm.characters,
                  sig->SignedInfo.SignatureMethod.Algorithm.charactersLen);
  out_raw(",", 1);
  out_key("references");
  out_raw("[", 1);
  for (uint16_t i = 0; i < sig->SignedInfo.Reference.arrayLen; i++) {
    const struct iso2_ReferenceType* ref = &sig->SignedInfo.Reference.array[i];
    if (i > 0) out_raw(",", 1);
    out_raw("{", 1);
    out_key("uri");
    if (ref->URI_isUsed) {
      out_json_string(ref->URI.characters, ref->URI.charactersLen);
    } else {
      out_str("null");
    }
    out_raw(",", 1);
    out_key("transform");
    if (ref->Transforms_isUsed) {
      out_json_string(ref->Transforms.Transform.Algorithm.characters,
                      ref->Transforms.Transform.Algorithm.charactersLen);
    } else {
      out_str("null");
    }
    out_raw(",", 1);
    out_key("digestMethod");
    out_json_string(ref->DigestMethod.Algorithm.characters,
                    ref->DigestMethod.Algorithm.charactersLen);
    out_raw(",", 1);
    out_key("digestValue");
    out_b64(ref->DigestValue.bytes, ref->DigestValue.bytesLen);
    out_raw("}", 1);
  }
  out_raw("],", 2);
  out_key("signatureValue");
  out_b64(sig->SignatureValue.CONTENT.bytes, sig->SignatureValue.CONTENT.bytesLen);
  out_raw(",", 1);
  out_key("signedInfo");
  int err = iso2_out_signed_info(&sig->SignedInfo);
  if (err != 0) return err;
  out_raw("}", 1);
  return 0;
}

// Body of a CertificateInstallationRes or CertificateUpdateRes plus the
// fragments of its four signed elements.
static int iso2_out_cert_res(const struct iso2_CertificateChainType* sa,
                             const struct iso2_CertificateChainType* contract,
                             const struct iso2_ContractSignatureEncryptedPrivateKeyType* enc,
                             const struct iso2_DiffieHellmanPublickeyType* dh,
                             const struct iso2_EMAIDType* emaid, int response_code,
                             const int16_t* retry_counter) {
  out_key("responseCode");
  out_int(response_code);
  out_raw(",", 1);
  if (retry_counter != NULL) {
    out_key("retryCounter");
    out_int(*retry_counter);
    out_raw(",", 1);
  }
  out_key("saProvisioningChain");
  iso2_out_chain(sa);
  out_raw(",", 1);
  out_key("contractChain");
  iso2_out_chain(contract);
  out_raw(",", 1);
  out_key("encryptedPrivateKey");
  out_raw("{", 1);
  out_key("id");
  out_json_string(enc->Id.characters, enc->Id.charactersLen);
  out_raw(",", 1);
  out_key("value");
  out_b64(enc->CONTENT.bytes, enc->CONTENT.bytesLen);
  out_raw("},", 2);
  out_key("dhPublicKey");
  out_raw("{", 1);
  out_key("id");
  out_json_string(dh->Id.characters, dh->Id.charactersLen);
  out_raw(",", 1);
  out_key("value");
  out_b64(dh->CONTENT.bytes, dh->CONTENT.bytesLen);
  out_raw("},", 2);
  out_key("emaid");
  out_raw("{", 1);
  out_key("id");
  out_json_string(emaid->Id.characters, emaid->Id.charactersLen);
  out_raw(",", 1);
  out_key("value");
  out_json_string(emaid->CONTENT.characters, emaid->CONTENT.charactersLen);
  out_raw("}", 1);

  out_raw(",", 1);
  out_key("fragments");
  out_raw("{", 1);
  struct iso2_exiFragment* frag =
      (struct iso2_exiFragment*)calloc(1, sizeof(struct iso2_exiFragment));
  if (frag == NULL) return GLUE_ERR_OOM;
  int first = 1;
  int err = 0;
  if (contract->Id_isUsed) {
    init_iso2_exiFragment(frag);
    frag->ContractSignatureCertChain_isUsed = 1;
    frag->ContractSignatureCertChain = *contract;
    err = iso2_out_fragment(contract->Id.characters, contract->Id.charactersLen, frag, &first);
  }
  if (err == 0) {
    init_iso2_exiFragment(frag);
    frag->ContractSignatureEncryptedPrivateKey_isUsed = 1;
    frag->ContractSignatureEncryptedPrivateKey = *enc;
    err = iso2_out_fragment(enc->Id.characters, enc->Id.charactersLen, frag, &first);
  }
  if (err == 0) {
    init_iso2_exiFragment(frag);
    frag->DHpublickey_isUsed = 1;
    frag->DHpublickey = *dh;
    err = iso2_out_fragment(dh->Id.characters, dh->Id.charactersLen, frag, &first);
  }
  if (err == 0) {
    init_iso2_exiFragment(frag);
    frag->eMAID_isUsed = 1;
    frag->eMAID = *emaid;
    err = iso2_out_fragment(emaid->Id.characters, emaid->Id.charactersLen, frag, &first);
  }
  free(frag);
  if (err != 0) return err;
  out_raw("}", 1);
  return 0;
}

static int iso2_out_document(struct iso2_exiDocument* doc) {
  struct iso2_V2G_Message* msg = &doc->V2G_Message;
  struct iso2_BodyType* body = &msg->Body;
  int err;
  out_raw("{", 1);
  out_key("schema");
  out_str("2,");
  out_key("sessionId");
  out_hex(msg->Header.SessionID.bytes, msg->Header.SessionID.bytesLen);
  out_raw(",", 1);
  err = iso2_out_signature(&msg->Header);
  if (err != 0) return err;
  out_raw(",", 1);
  out_key("body");
  out_raw("{", 1);

  struct iso2_exiFragment* frag =
      (struct iso2_exiFragment*)calloc(1, sizeof(struct iso2_exiFragment));
  if (frag == NULL) return GLUE_ERR_OOM;
  int first = 1;

  if (body->CertificateInstallationReq_isUsed) {
    struct iso2_CertificateInstallationReqType* req = &body->CertificateInstallationReq;
    out_key("type");
    out_str("\"CertificateInstallationReq\",");
    out_key("id");
    out_json_string(req->Id.characters, req->Id.charactersLen);
    out_raw(",", 1);
    out_key("oemProvisioningCert");
    out_b64(req->OEMProvisioningCert.bytes, req->OEMProvisioningCert.bytesLen);
    out_raw(",", 1);
    iso2_out_root_ids(&req->ListOfRootCertificateIDs);
    out_raw(",", 1);
    out_key("fragments");
    out_raw("{", 1);
    init_iso2_exiFragment(frag);
    frag->CertificateInstallationReq_isUsed = 1;
    frag->CertificateInstallationReq = *req;
    err = iso2_out_fragment(req->Id.characters, req->Id.charactersLen, frag, &first);
    out_raw("}", 1);
  } else if (body->CertificateUpdateReq_isUsed) {
    struct iso2_CertificateUpdateReqType* req = &body->CertificateUpdateReq;
    out_key("type");
    out_str("\"CertificateUpdateReq\",");
    out_key("id");
    out_json_string(req->Id.characters, req->Id.charactersLen);
    out_raw(",", 1);
    out_key("contractChain");
    iso2_out_chain(&req->ContractSignatureCertChain);
    out_raw(",", 1);
    out_key("emaid");
    out_json_string(req->eMAID.characters, req->eMAID.charactersLen);
    out_raw(",", 1);
    iso2_out_root_ids(&req->ListOfRootCertificateIDs);
    out_raw(",", 1);
    out_key("fragments");
    out_raw("{", 1);
    init_iso2_exiFragment(frag);
    frag->CertificateUpdateReq_isUsed = 1;
    frag->CertificateUpdateReq = *req;
    err = iso2_out_fragment(req->Id.characters, req->Id.charactersLen, frag, &first);
    out_raw("}", 1);
  } else if (body->CertificateInstallationRes_isUsed) {
    struct iso2_CertificateInstallationResType* res = &body->CertificateInstallationRes;
    out_key("type");
    out_str("\"CertificateInstallationRes\",");
    err = iso2_out_cert_res(&res->SAProvisioningCertificateChain, &res->ContractSignatureCertChain,
                            &res->ContractSignatureEncryptedPrivateKey, &res->DHpublickey,
                            &res->eMAID, (int)res->ResponseCode, NULL);
  } else if (body->CertificateUpdateRes_isUsed) {
    struct iso2_CertificateUpdateResType* res = &body->CertificateUpdateRes;
    out_key("type");
    out_str("\"CertificateUpdateRes\",");
    err = iso2_out_cert_res(&res->SAProvisioningCertificateChain, &res->ContractSignatureCertChain,
                            &res->ContractSignatureEncryptedPrivateKey, &res->DHpublickey,
                            &res->eMAID, (int)res->ResponseCode,
                            res->RetryCounter_isUsed ? &res->RetryCounter : NULL);
  } else {
    err = GLUE_ERR_UNSUPPORTED_MESSAGE;
  }
  free(frag);
  if (err != 0) return err;
  out_raw("}}", 2);
  return 0;
}

static int iso2_decode(const uint8_t* in, uint32_t len) {
  struct iso2_exiDocument* doc =
      (struct iso2_exiDocument*)calloc(1, sizeof(struct iso2_exiDocument));
  if (doc == NULL) return GLUE_ERR_OOM;
  init_iso2_exiDocument(doc);
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, (uint8_t*)in, len, 0, NULL);
  int err = decode_iso2_exiDocument(&stream, doc);
  if (err == 0) err = iso2_out_document(doc);
  free(doc);
  return err;
}

static int iso2_add_sub(struct iso2_CertificateChainType* chain, const field_t* f) {
  struct iso2_SubCertificatesType* subs = &chain->SubCertificates;
  if (subs->Certificate.arrayLen >= iso2_certificateType_4_ARRAY_SIZE) {
    return EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
  }
  COPY_BYTES(subs->Certificate.array[subs->Certificate.arrayLen], f, iso2_certificateType_BYTES_SIZE);
  subs->Certificate.arrayLen++;
  chain->SubCertificates_isUsed = 1;
  return 0;
}

static int iso2_encode(const uint8_t* rec, uint32_t rec_len) {
  struct iso2_exiDocument* doc =
      (struct iso2_exiDocument*)calloc(1, sizeof(struct iso2_exiDocument));
  if (doc == NULL) return GLUE_ERR_OOM;
  init_iso2_exiDocument(doc);
  struct iso2_V2G_Message* msg = &doc->V2G_Message;
  struct iso2_SignatureType* sig = &msg->Header.Signature;
  struct iso2_BodyType* body = &msg->Body;
  init_iso2_MessageHeaderType(&msg->Header);
  init_iso2_BodyType(body);

  // Pointers into the body selected by the message type.
  struct iso2_CertificateChainType* sa = NULL;
  struct iso2_CertificateChainType* contract = NULL;
  struct iso2_ContractSignatureEncryptedPrivateKeyType* enc = NULL;
  struct iso2_DiffieHellmanPublickeyType* dh = NULL;
  struct iso2_EMAIDType* emaid = NULL;
  struct iso2_ListOfRootCertificateIDsType* roots = NULL;

  reader_t r = {rec, rec_len, 0};
  field_t f;
  int rc = 0;
  int err = 0;
  uint32_t msg_type = 0;
  struct iso2_ReferenceType* ref = NULL;

  while (err == 0 && (rc = next_field(&r, &f)) > 0) {
    switch (f.tag) {
      case T_MSG_TYPE:
        msg_type = field_u32(&f);
        if (msg_type == 1) {
          body->CertificateInstallationReq_isUsed = 1;
          init_iso2_CertificateInstallationReqType(&body->CertificateInstallationReq);
          roots = &body->CertificateInstallationReq.ListOfRootCertificateIDs;
        } else if (msg_type == 2) {
          body->CertificateUpdateReq_isUsed = 1;
          init_iso2_CertificateUpdateReqType(&body->CertificateUpdateReq);
          contract = &body->CertificateUpdateReq.ContractSignatureCertChain;
          roots = &body->CertificateUpdateReq.ListOfRootCertificateIDs;
        } else if (msg_type == 3) {
          struct iso2_CertificateInstallationResType* res = &body->CertificateInstallationRes;
          body->CertificateInstallationRes_isUsed = 1;
          init_iso2_CertificateInstallationResType(res);
          sa = &res->SAProvisioningCertificateChain;
          contract = &res->ContractSignatureCertChain;
          enc = &res->ContractSignatureEncryptedPrivateKey;
          dh = &res->DHpublickey;
          emaid = &res->eMAID;
        } else if (msg_type == 4) {
          struct iso2_CertificateUpdateResType* res = &body->CertificateUpdateRes;
          body->CertificateUpdateRes_isUsed = 1;
          init_iso2_CertificateUpdateResType(res);
          sa = &res->SAProvisioningCertificateChain;
          contract = &res->ContractSignatureCertChain;
          enc = &res->ContractSignatureEncryptedPrivateKey;
          dh = &res->DHpublickey;
          emaid = &res->eMAID;
        } else {
          err = GLUE_ERR_UNSUPPORTED_MESSAGE;
        }
        break;
      case T_SESSION_ID:
        COPY_BYTES(msg->Header.SessionID, &f, iso2_sessionIDType_BYTES_SIZE);
        break;
      case T_SIG_REF_URI:
        if (sig->SignedInfo.Reference.arrayLen >= iso2_ReferenceType_4_ARRAY_SIZE) {
          err = EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
          break;
        }
        msg->Header.Signature_isUsed = 1;
        ref = &sig->SignedInfo.Reference.array[sig->SignedInfo.Reference.arrayLen++];
        init_iso2_ReferenceType(ref);
        COPY_CHARS(ref->URI, &f, iso2_URI_CHARACTER_SIZE);
        ref->URI_isUsed = 1;
        ref->Transforms_isUsed = 1;
        set_chars(ref->Transforms.Transform.Algorithm.characters,
                  &ref->Transforms.Transform.Algorithm.charactersLen, CANONICAL_EXI);
        break;
      case T_SIG_REF_DIGEST:
        if (ref == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(ref->DigestValue, &f, iso2_DigestValueType_BYTES_SIZE);
        break;
      case T_SIG_METHOD:
        COPY_CHARS(sig->SignedInfo.SignatureMethod.Algorithm, &f, iso2_Algorithm_CHARACTER_SIZE);
        break;
      case T_SIG_DIGEST_METHOD:
        for (uint16_t i = 0; i < sig->SignedInfo.Reference.arrayLen; i++) {
          COPY_CHARS(sig->SignedInfo.Reference.array[i].DigestMethod.Algorithm, &f,
                     iso2_Algorithm_CHARACTER_SIZE);
        }
        break;
      case T_SIG_VALUE:
        COPY_BYTES(sig->SignatureValue.CONTENT, &f, iso2_SignatureValueType_BYTES_SIZE);
        break;
      case T_BODY_ID:
        if (msg_type == 1) {
          COPY_CHARS(body->CertificateInstallationReq.Id, &f, iso2_Id_CHARACTER_SIZE);
        } else if (msg_type == 2) {
          COPY_CHARS(body->CertificateUpdateReq.Id, &f, iso2_Id_CHARACTER_SIZE);
        } else {
          err = GLUE_ERR_RECORD;
        }
        break;
      case T_OEM_CERT:
        if (msg_type != 1) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(body->CertificateInstallationReq.OEMProvisioningCert, &f,
                   iso2_certificateType_BYTES_SIZE);
        break;
      case T_ROOT_ISSUER: {
        if (roots == NULL || roots->RootCertificateID.arrayLen >= iso2_X509IssuerSerialType_5_ARRAY_SIZE) {
          err = roots == NULL ? GLUE_ERR_RECORD : EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
          break;
        }
        struct iso2_X509IssuerSerialType* id =
            &roots->RootCertificateID.array[roots->RootCertificateID.arrayLen++];
        COPY_CHARS(id->X509IssuerName, &f, iso2_X509IssuerName_CHARACTER_SIZE);
        break;
      }
      case T_ROOT_SERIAL: {
        if (roots == NULL || roots->RootCertificateID.arrayLen == 0) {
          err = GLUE_ERR_RECORD;
          break;
        }
        struct iso2_X509IssuerSerialType* id =
            &roots->RootCertificateID.array[roots->RootCertificateID.arrayLen - 1];
        id->X509SerialNumber.is_negative = 0;
        err = exi_basetypes_convert_bytes_to_unsigned(&id->X509SerialNumber.data, f.value, f.len);
        break;
      }
      case T_RESPONSE_CODE:
        if (msg_type == 3) {
          body->CertificateInstallationRes.ResponseCode = (iso2_responseCodeType)field_u32(&f);
        } else if (msg_type == 4) {
          body->CertificateUpdateRes.ResponseCode = (iso2_responseCodeType)field_u32(&f);
        } else {
          err = GLUE_ERR_RECORD;
        }
        break;
      case T_SA_CERT:
        if (sa == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(sa->Certificate, &f, iso2_certificateType_BYTES_SIZE);
        break;
      case T_SA_SUBCERT:
        err = sa == NULL ? GLUE_ERR_RECORD : iso2_add_sub(sa, &f);
        break;
      case T_CONTRACT_CHAIN_ID:
        if (contract == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(contract->Id, &f, iso2_Id_CHARACTER_SIZE);
        contract->Id_isUsed = 1;
        break;
      case T_CONTRACT_CERT:
        if (contract == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(contract->Certificate, &f, iso2_certificateType_BYTES_SIZE);
        break;
      case T_CONTRACT_SUBCERT:
        err = contract == NULL ? GLUE_ERR_RECORD : iso2_add_sub(contract, &f);
        break;
      case T_ENC_KEY_ID:
        if (enc == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(enc->Id, &f, iso2_Id_CHARACTER_SIZE);
        break;
      case T_ENC_KEY:
        if (enc == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(enc->CONTENT, &f, iso2_ContractSignatureEncryptedPrivateKeyType_BYTES_SIZE);
        break;
      case T_DH_ID:
        if (dh == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(dh->Id, &f, iso2_Id_CHARACTER_SIZE);
        break;
      case T_DH_KEY:
        if (dh == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(dh->CONTENT, &f, iso2_DiffieHellmanPublickeyType_BYTES_SIZE);
        break;
      case T_EMAID_ID:
        if (emaid == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(emaid->Id, &f, iso2_Id_CHARACTER_SIZE);
        break;
      case T_EMAID:
        if (emaid != NULL) {
          COPY_CHARS(emaid->CONTENT, &f, iso2_CONTENT_CHARACTER_SIZE);
        } else if (msg_type == 2) {
          COPY_CHARS(body->CertificateUpdateReq.eMAID, &f, iso2_eMAID_CHARACTER_SIZE);
        } else {
          err = GLUE_ERR_RECORD;
        }
        break;
      case T_RETRY_COUNTER:
        if (msg_type != 4) {
          err = GLUE_ERR_RECORD;
          break;
        }
        body->CertificateUpdateRes.RetryCounter = (int16_t)(field_u32(&f) & 0xffff);
        body->CertificateUpdateRes.RetryCounter_isUsed = 1;
        break;
      default:
        err = GLUE_ERR_RECORD;
        break;
    }
  }
  if (err == 0 && rc < 0) err = rc;
  if (err == 0 && msg_type == 0) err = GLUE_ERR_RECORD;

  if (err == 0 && msg->Header.Signature_isUsed) {
    set_chars(sig->SignedInfo.CanonicalizationMethod.Algorithm.characters,
              &sig->SignedInfo.CanonicalizationMethod.Algorithm.charactersLen, CANONICAL_EXI);
  }

  uint8_t* exi = NULL;
  if (err == 0) {
    exi = (uint8_t*)malloc(V2G_EXI_MAX);
    if (exi == NULL) err = GLUE_ERR_OOM;
  }
  size_t exi_len = 0;
  if (err == 0) {
    exi_bitstream_t stream;
    exi_bitstream_init(&stream, exi, V2G_EXI_MAX, 0, NULL);
    err = encode_iso2_exiDocument(&stream, doc);
    exi_len = exi_bitstream_get_length(&stream);
  }
  if (err == 0) {
    out_raw("{", 1);
    out_key("exi");
    out_b64(exi, exi_len);
    out_raw(",", 1);
    out_key("signedInfo");
    if (msg->Header.Signature_isUsed) {
      err = iso2_out_signed_info(&sig->SignedInfo);
    } else {
      out_str("null");
    }
  }
  if (err == 0) {
    out_raw(",", 1);
    out_key("decoded");
    err = iso2_out_document(doc);
  }
  if (err == 0) out_raw("}", 1);
  free(exi);
  free(doc);
  return err;
}

// =============================================================== ISO 15118-20

static void iso20_out_subs(const struct iso20_SubCertificatesType* subs, int used) {
  out_key("subCertificates");
  out_raw("[", 1);
  if (used) {
    for (uint16_t i = 0; i < subs->Certificate.arrayLen; i++) {
      if (i > 0) out_raw(",", 1);
      out_b64(subs->Certificate.array[i].bytes, subs->Certificate.array[i].bytesLen);
    }
  }
  out_raw("]", 1);
}

static int iso20_signed_info_bytes(const struct iso20_SignedInfoType* signed_info, uint8_t* buf,
                                   size_t* len) {
  struct iso20_xmldsigFragment* frag =
      (struct iso20_xmldsigFragment*)calloc(1, sizeof(struct iso20_xmldsigFragment));
  if (frag == NULL) return GLUE_ERR_OOM;
  init_iso20_xmldsigFragment(frag);
  frag->SignedInfo_isUsed = 1;
  frag->SignedInfo = *signed_info;
  frag->SignedInfo.Id_isUsed = 0;
  frag->SignedInfo.CanonicalizationMethod.ANY_isUsed = 0;
  frag->SignedInfo.SignatureMethod.HMACOutputLength_isUsed = 0;
  frag->SignedInfo.SignatureMethod.ANY_isUsed = 0;
  for (uint16_t i = 0; i < frag->SignedInfo.Reference.arrayLen; i++) {
    struct iso20_ReferenceType* ref = &frag->SignedInfo.Reference.array[i];
    ref->Type_isUsed = 0;
    ref->Transforms.Transform.ANY_isUsed = 0;
    ref->Transforms.Transform.XPath_isUsed = 0;
    ref->DigestMethod.ANY_isUsed = 0;
  }
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, buf, V2G_EXI_MAX, 0, NULL);
  int err = encode_iso20_xmldsigFragment(&stream, frag);
  free(frag);
  *len = exi_bitstream_get_length(&stream);
  return err;
}

static int iso20_out_signature(const struct iso20_MessageHeaderType* header) {
  out_key("signature");
  if (!header->Signature_isUsed) {
    out_str("null");
    return 0;
  }
  const struct iso20_SignatureType* sig = &header->Signature;
  out_raw("{", 1);
  out_key("canonicalizationMethod");
  out_json_string(sig->SignedInfo.CanonicalizationMethod.Algorithm.characters,
                  sig->SignedInfo.CanonicalizationMethod.Algorithm.charactersLen);
  out_raw(",", 1);
  out_key("signatureMethod");
  out_json_string(sig->SignedInfo.SignatureMethod.Algorithm.characters,
                  sig->SignedInfo.SignatureMethod.Algorithm.charactersLen);
  out_raw(",", 1);
  out_key("references");
  out_raw("[", 1);
  for (uint16_t i = 0; i < sig->SignedInfo.Reference.arrayLen; i++) {
    const struct iso20_ReferenceType* ref = &sig->SignedInfo.Reference.array[i];
    if (i > 0) out_raw(",", 1);
    out_raw("{", 1);
    out_key("uri");
    if (ref->URI_isUsed) {
      out_json_string(ref->URI.characters, ref->URI.charactersLen);
    } else {
      out_str("null");
    }
    out_raw(",", 1);
    out_key("transform");
    if (ref->Transforms_isUsed) {
      out_json_string(ref->Transforms.Transform.Algorithm.characters,
                      ref->Transforms.Transform.Algorithm.charactersLen);
    } else {
      out_str("null");
    }
    out_raw(",", 1);
    out_key("digestMethod");
    out_json_string(ref->DigestMethod.Algorithm.characters,
                    ref->DigestMethod.Algorithm.charactersLen);
    out_raw(",", 1);
    out_key("digestValue");
    out_b64(ref->DigestValue.bytes, ref->DigestValue.bytesLen);
    out_raw("}", 1);
  }
  out_raw("],", 2);
  out_key("signatureValue");
  out_b64(sig->SignatureValue.CONTENT.bytes, sig->SignatureValue.CONTENT.bytesLen);
  out_raw(",", 1);
  out_key("signedInfo");
  uint8_t* buf = scratch_buf();
  if (buf == NULL) return GLUE_ERR_OOM;
  size_t len = 0;
  int err = iso20_signed_info_bytes(&sig->SignedInfo, buf, &len);
  if (err != 0) return err;
  out_b64(buf, len);
  out_raw("}", 1);
  return 0;
}

// OEMProvisioningCertificateChain as an EXI fragment (event 128 of the
// CommonMessages fragment grammar, then the end-fragment event 282).
static int iso20_oem_chain_fragment(const struct iso20_SignedCertificateChainType* chain,
                                    uint8_t* buf, size_t* len) {
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, buf, V2G_EXI_MAX, 0, NULL);
  int err = exi_header_write(&stream);
  if (err == 0) err = exi_basetypes_encoder_nbit_uint(&stream, 9, 128);
  if (err == 0) err = encode_iso20_SignedCertificateChainType(&stream, chain);
  if (err == 0) err = exi_basetypes_encoder_nbit_uint(&stream, 9, 282);
  *len = exi_bitstream_get_length(&stream);
  return err;
}

static int iso20_signed_data_fragment(const struct iso20_SignedInstallationDataType* data,
                                      uint8_t* buf, size_t* len) {
  struct iso20_exiFragment* frag =
      (struct iso20_exiFragment*)calloc(1, sizeof(struct iso20_exiFragment));
  if (frag == NULL) return GLUE_ERR_OOM;
  init_iso20_exiFragment(frag);
  frag->SignedInstallationData_isUsed = 1;
  frag->SignedInstallationData = *data;
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, buf, V2G_EXI_MAX, 0, NULL);
  int err = encode_iso20_exiFragment(&stream, frag);
  free(frag);
  *len = exi_bitstream_get_length(&stream);
  return err;
}

static int iso20_out_document(struct iso20_exiDocument* doc) {
  int err = 0;
  const struct iso20_MessageHeaderType* header;
  if (doc->CertificateInstallationReq_isUsed) {
    header = &doc->CertificateInstallationReq.Header;
  } else if (doc->CertificateInstallationRes_isUsed) {
    header = &doc->CertificateInstallationRes.Header;
  } else {
    return GLUE_ERR_UNSUPPORTED_MESSAGE;
  }
  uint8_t* buf = scratch_buf();
  if (buf == NULL) return GLUE_ERR_OOM;
  size_t len = 0;

  out_raw("{", 1);
  out_key("schema");
  out_str("20,");
  out_key("sessionId");
  out_hex(header->SessionID.bytes, header->SessionID.bytesLen);
  out_raw(",", 1);
  out_key("timestamp");
  out_raw("\"", 1);
  out_uint(header->TimeStamp);
  out_raw("\",", 2);
  err = iso20_out_signature(header);
  if (err != 0) return err;
  out_raw(",", 1);
  out_key("body");
  out_raw("{", 1);

  if (doc->CertificateInstallationReq_isUsed) {
    const struct iso20_CertificateInstallationReqType* req = &doc->CertificateInstallationReq;
    const struct iso20_SignedCertificateChainType* oem = &req->OEMProvisioningCertificateChain;
    out_key("type");
    out_str("\"CertificateInstallationReq\",");
    out_key("oemProvisioningChain");
    out_raw("{", 1);
    out_key("id");
    out_json_string(oem->Id.characters, oem->Id.charactersLen);
    out_raw(",", 1);
    out_key("certificate");
    out_b64(oem->Certificate.bytes, oem->Certificate.bytesLen);
    out_raw(",", 1);
    iso20_out_subs(&oem->SubCertificates, oem->SubCertificates_isUsed);
    out_raw("},", 2);
    out_key("rootCertificateIds");
    out_raw("[", 1);
    for (uint16_t i = 0; i < req->ListOfRootCertificateIDs.RootCertificateID.arrayLen; i++) {
      const struct iso20_X509IssuerSerialType* id =
          &req->ListOfRootCertificateIDs.RootCertificateID.array[i];
      uint8_t serial[32];
      size_t serial_len = 0;
      serial_from_exi(&id->X509SerialNumber, serial, &serial_len);
      if (i > 0) out_raw(",", 1);
      out_raw("{", 1);
      out_key("issuerName");
      out_json_string(id->X509IssuerName.characters, id->X509IssuerName.charactersLen);
      out_raw(",", 1);
      out_key("serialNumber");
      out_hex(serial, serial_len);
      out_raw("}", 1);
    }
    out_raw("],", 2);
    out_key("maximumContractCertificateChains");
    out_uint(req->MaximumContractCertificateChains);
    out_raw(",", 1);
    out_key("prioritizedEmaids");
    out_raw("[", 1);
    if (req->PrioritizedEMAIDs_isUsed) {
      for (uint16_t i = 0; i < req->PrioritizedEMAIDs.EMAID.arrayLen; i++) {
        if (i > 0) out_raw(",", 1);
        out_json_string(req->PrioritizedEMAIDs.EMAID.array[i].characters,
                        req->PrioritizedEMAIDs.EMAID.array[i].charactersLen);
      }
    }
    out_raw("],", 2);
    out_key("fragments");
    out_raw("{", 1);
    err = iso20_oem_chain_fragment(oem, buf, &len);
    if (err != 0) return err;
    out_json_string(oem->Id.characters, oem->Id.charactersLen);
    out_raw(":", 1);
    out_b64(buf, len);
    out_raw("}", 1);
  } else {
    const struct iso20_CertificateInstallationResType* res = &doc->CertificateInstallationRes;
    const struct iso20_SignedInstallationDataType* data = &res->SignedInstallationData;
    out_key("type");
    out_str("\"CertificateInstallationRes\",");
    out_key("responseCode");
    out_int((int)res->ResponseCode);
    out_raw(",", 1);
    out_key("evseProcessing");
    out_int((int)res->EVSEProcessing);
    out_raw(",", 1);
    out_key("cpsChain");
    out_raw("{", 1);
    out_key("certificate");
    out_b64(res->CPSCertificateChain.Certificate.bytes,
            res->CPSCertificateChain.Certificate.bytesLen);
    out_raw(",", 1);
    iso20_out_subs(&res->CPSCertificateChain.SubCertificates,
                   res->CPSCertificateChain.SubCertificates_isUsed);
    out_raw("},", 2);
    out_key("signedInstallationData");
    out_raw("{", 1);
    out_key("id");
    out_json_string(data->Id.characters, data->Id.charactersLen);
    out_raw(",", 1);
    out_key("contractChain");
    out_raw("{", 1);
    out_key("certificate");
    out_b64(data->ContractCertificateChain.Certificate.bytes,
            data->ContractCertificateChain.Certificate.bytesLen);
    out_raw(",", 1);
    iso20_out_subs(&data->ContractCertificateChain.SubCertificates, 1);
    out_raw("},", 2);
    out_key("ecdhCurve");
    out_int((int)data->ECDHCurve);
    out_raw(",", 1);
    out_key("dhPublicKey");
    out_b64(data->DHPublicKey.bytes, data->DHPublicKey.bytesLen);
    if (data->SECP521_EncryptedPrivateKey_isUsed) {
      out_raw(",", 1);
      out_key("secp521EncryptedPrivateKey");
      out_b64(data->SECP521_EncryptedPrivateKey.bytes, data->SECP521_EncryptedPrivateKey.bytesLen);
    }
    if (data->X448_EncryptedPrivateKey_isUsed) {
      out_raw(",", 1);
      out_key("x448EncryptedPrivateKey");
      out_b64(data->X448_EncryptedPrivateKey.bytes, data->X448_EncryptedPrivateKey.bytesLen);
    }
    if (data->TPM_EncryptedPrivateKey_isUsed) {
      out_raw(",", 1);
      out_key("tpmEncryptedPrivateKey");
      out_b64(data->TPM_EncryptedPrivateKey.bytes, data->TPM_EncryptedPrivateKey.bytesLen);
    }
    out_raw("},", 2);
    out_key("remainingContractCertificateChains");
    out_uint(res->RemainingContractCertificateChains);
    out_raw(",", 1);
    out_key("fragments");
    out_raw("{", 1);
    err = iso20_signed_data_fragment(data, buf, &len);
    if (err != 0) return err;
    out_json_string(data->Id.characters, data->Id.charactersLen);
    out_raw(":", 1);
    out_b64(buf, len);
    out_raw("}", 1);
  }
  out_raw("}}", 2);
  return 0;
}

static int iso20_decode(const uint8_t* in, uint32_t len) {
  struct iso20_exiDocument* doc =
      (struct iso20_exiDocument*)calloc(1, sizeof(struct iso20_exiDocument));
  if (doc == NULL) return GLUE_ERR_OOM;
  init_iso20_exiDocument(doc);
  exi_bitstream_t stream;
  exi_bitstream_init(&stream, (uint8_t*)in, len, 0, NULL);
  int err = decode_iso20_exiDocument(&stream, doc);
  if (err == 0) err = iso20_out_document(doc);
  free(doc);
  return err;
}

static int iso20_add_sub(struct iso20_SubCertificatesType* subs, const field_t* f) {
  if (subs->Certificate.arrayLen >= iso20_certificateType_3_ARRAY_SIZE) {
    return EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
  }
  COPY_BYTES(subs->Certificate.array[subs->Certificate.arrayLen], f,
             iso20_certificateType_BYTES_SIZE);
  subs->Certificate.arrayLen++;
  return 0;
}

static int iso20_encode(const uint8_t* rec, uint32_t rec_len) {
  struct iso20_exiDocument* doc =
      (struct iso20_exiDocument*)calloc(1, sizeof(struct iso20_exiDocument));
  if (doc == NULL) return GLUE_ERR_OOM;
  init_iso20_exiDocument(doc);

  struct iso20_MessageHeaderType* header = NULL;
  struct iso20_CertificateInstallationReqType* req = NULL;
  struct iso20_CertificateInstallationResType* res = NULL;
  struct iso20_ReferenceType* ref = NULL;
  struct iso20_ListOfRootCertificateIDsType* roots = NULL;
  uint32_t enc_kind = 0;

  reader_t r = {rec, rec_len, 0};
  field_t f;
  int rc = 0;
  int err = 0;

  while (err == 0 && (rc = next_field(&r, &f)) > 0) {
    if (f.tag != T_MSG_TYPE && header == NULL) {
      err = GLUE_ERR_RECORD;
      break;
    }
    struct iso20_SignatureType* sig = header != NULL ? &header->Signature : NULL;
    switch (f.tag) {
      case T_MSG_TYPE: {
        uint32_t t = field_u32(&f);
        if (t == 1) {
          doc->CertificateInstallationReq_isUsed = 1;
          req = &doc->CertificateInstallationReq;
          init_iso20_CertificateInstallationReqType(req);
          header = &req->Header;
          roots = &req->ListOfRootCertificateIDs;
        } else if (t == 3) {
          doc->CertificateInstallationRes_isUsed = 1;
          res = &doc->CertificateInstallationRes;
          init_iso20_CertificateInstallationResType(res);
          header = &res->Header;
          res->SignedInstallationData.ContractCertificateChain.SubCertificates.Certificate.arrayLen = 0;
        } else {
          err = GLUE_ERR_UNSUPPORTED_MESSAGE;
        }
        if (header != NULL) init_iso20_MessageHeaderType(header);
        break;
      }
      case T_SESSION_ID:
        COPY_BYTES(header->SessionID, &f, iso20_sessionIDType_BYTES_SIZE);
        break;
      case T_TIMESTAMP:
        header->TimeStamp = field_u64(&f);
        break;
      case T_SIG_REF_URI:
        if (sig->SignedInfo.Reference.arrayLen >= iso20_ReferenceType_4_ARRAY_SIZE) {
          err = EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
          break;
        }
        header->Signature_isUsed = 1;
        ref = &sig->SignedInfo.Reference.array[sig->SignedInfo.Reference.arrayLen++];
        init_iso20_ReferenceType(ref);
        COPY_CHARS(ref->URI, &f, iso20_URI_CHARACTER_SIZE);
        ref->URI_isUsed = 1;
        ref->Transforms_isUsed = 1;
        set_chars(ref->Transforms.Transform.Algorithm.characters,
                  &ref->Transforms.Transform.Algorithm.charactersLen, CANONICAL_EXI);
        break;
      case T_SIG_REF_DIGEST:
        if (ref == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(ref->DigestValue, &f, iso20_DigestValueType_BYTES_SIZE);
        break;
      case T_SIG_METHOD:
        COPY_CHARS(sig->SignedInfo.SignatureMethod.Algorithm, &f, iso20_Algorithm_CHARACTER_SIZE);
        break;
      case T_SIG_DIGEST_METHOD:
        for (uint16_t i = 0; i < sig->SignedInfo.Reference.arrayLen; i++) {
          COPY_CHARS(sig->SignedInfo.Reference.array[i].DigestMethod.Algorithm, &f,
                     iso20_Algorithm_CHARACTER_SIZE);
        }
        break;
      case T_SIG_VALUE:
        COPY_BYTES(sig->SignatureValue.CONTENT, &f, iso20_SignatureValueType_BYTES_SIZE);
        break;
      case T_OEM_CHAIN_ID:
        if (req == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(req->OEMProvisioningCertificateChain.Id, &f, iso20_Id_CHARACTER_SIZE);
        break;
      case T_OEM_CERT:
        if (req == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(req->OEMProvisioningCertificateChain.Certificate, &f,
                   iso20_certificateType_BYTES_SIZE);
        break;
      case T_OEM_SUBCERT:
        if (req == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        req->OEMProvisioningCertificateChain.SubCertificates_isUsed = 1;
        err = iso20_add_sub(&req->OEMProvisioningCertificateChain.SubCertificates, &f);
        break;
      case T_ROOT_ISSUER: {
        if (roots == NULL || roots->RootCertificateID.arrayLen >= iso20_X509IssuerSerialType_20_ARRAY_SIZE) {
          err = roots == NULL ? GLUE_ERR_RECORD : EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
          break;
        }
        struct iso20_X509IssuerSerialType* id =
            &roots->RootCertificateID.array[roots->RootCertificateID.arrayLen++];
        COPY_CHARS(id->X509IssuerName, &f, iso20_X509IssuerName_CHARACTER_SIZE);
        break;
      }
      case T_ROOT_SERIAL: {
        if (roots == NULL || roots->RootCertificateID.arrayLen == 0) {
          err = GLUE_ERR_RECORD;
          break;
        }
        struct iso20_X509IssuerSerialType* id =
            &roots->RootCertificateID.array[roots->RootCertificateID.arrayLen - 1];
        id->X509SerialNumber.is_negative = 0;
        err = exi_basetypes_convert_bytes_to_unsigned(&id->X509SerialNumber.data, f.value, f.len);
        break;
      }
      case T_MAX_CHAINS:
        if (req == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        req->MaximumContractCertificateChains = (uint8_t)field_u32(&f);
        break;
      case T_PRIORITIZED_EMAID: {
        if (req == NULL ||
            req->PrioritizedEMAIDs.EMAID.arrayLen >= iso20_identifierType_8_ARRAY_SIZE) {
          err = req == NULL ? GLUE_ERR_RECORD : EXI_ERROR__ARRAY_OUT_OF_BOUNDS;
          break;
        }
        req->PrioritizedEMAIDs_isUsed = 1;
        COPY_CHARS(req->PrioritizedEMAIDs.EMAID.array[req->PrioritizedEMAIDs.EMAID.arrayLen], &f,
                   iso20_EMAID_CHARACTER_SIZE);
        req->PrioritizedEMAIDs.EMAID.arrayLen++;
        break;
      }
      case T_RESPONSE_CODE:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        res->ResponseCode = (iso20_responseCodeType)field_u32(&f);
        break;
      case T_EVSE_PROCESSING:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        res->EVSEProcessing = (iso20_processingType)field_u32(&f);
        break;
      case T_SA_CERT:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(res->CPSCertificateChain.Certificate, &f, iso20_certificateType_BYTES_SIZE);
        break;
      case T_SA_SUBCERT:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        res->CPSCertificateChain.SubCertificates_isUsed = 1;
        err = iso20_add_sub(&res->CPSCertificateChain.SubCertificates, &f);
        break;
      case T_SIGNED_DATA_ID:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_CHARS(res->SignedInstallationData.Id, &f, iso20_Id_CHARACTER_SIZE);
        break;
      case T_CONTRACT_CERT:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(res->SignedInstallationData.ContractCertificateChain.Certificate, &f,
                   iso20_certificateType_BYTES_SIZE);
        break;
      case T_CONTRACT_SUBCERT:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        err = iso20_add_sub(&res->SignedInstallationData.ContractCertificateChain.SubCertificates,
                            &f);
        break;
      case T_ECDH_CURVE:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        res->SignedInstallationData.ECDHCurve = (iso20_ecdhCurveType)field_u32(&f);
        break;
      case T_DH_KEY:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        COPY_BYTES(res->SignedInstallationData.DHPublicKey, &f, iso20_dhPublicKeyType_BYTES_SIZE);
        break;
      case T_ENC_KEY_KIND:
        enc_kind = field_u32(&f);
        break;
      case T_ENC_KEY:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        if (enc_kind == 0) {
          COPY_BYTES(res->SignedInstallationData.SECP521_EncryptedPrivateKey, &f,
                     iso20_secp521_EncryptedPrivateKeyType_BYTES_SIZE);
          res->SignedInstallationData.SECP521_EncryptedPrivateKey_isUsed = 1;
        } else if (enc_kind == 1) {
          COPY_BYTES(res->SignedInstallationData.X448_EncryptedPrivateKey, &f,
                     iso20_x448_EncryptedPrivateKeyType_BYTES_SIZE);
          res->SignedInstallationData.X448_EncryptedPrivateKey_isUsed = 1;
        } else {
          COPY_BYTES(res->SignedInstallationData.TPM_EncryptedPrivateKey, &f,
                     iso20_tpm_EncryptedPrivateKeyType_BYTES_SIZE);
          res->SignedInstallationData.TPM_EncryptedPrivateKey_isUsed = 1;
        }
        break;
      case T_REMAINING:
        if (res == NULL) {
          err = GLUE_ERR_RECORD;
          break;
        }
        res->RemainingContractCertificateChains = (uint8_t)field_u32(&f);
        break;
      default:
        err = GLUE_ERR_RECORD;
        break;
    }
  }
  if (err == 0 && rc < 0) err = rc;
  if (err == 0 && header == NULL) err = GLUE_ERR_RECORD;
  if (err == 0 && header->Signature_isUsed) {
    set_chars(header->Signature.SignedInfo.CanonicalizationMethod.Algorithm.characters,
              &header->Signature.SignedInfo.CanonicalizationMethod.Algorithm.charactersLen,
              CANONICAL_EXI);
  }

  uint8_t* exi = NULL;
  size_t exi_len = 0;
  if (err == 0) {
    exi = (uint8_t*)malloc(V2G_EXI_MAX);
    if (exi == NULL) err = GLUE_ERR_OOM;
  }
  if (err == 0) {
    exi_bitstream_t stream;
    exi_bitstream_init(&stream, exi, V2G_EXI_MAX, 0, NULL);
    err = encode_iso20_exiDocument(&stream, doc);
    exi_len = exi_bitstream_get_length(&stream);
  }
  if (err == 0) {
    out_raw("{", 1);
    out_key("exi");
    out_b64(exi, exi_len);
    out_raw(",", 1);
    out_key("signedInfo");
    if (header->Signature_isUsed) {
      uint8_t* buf = scratch_buf();
      size_t len = 0;
      err = buf == NULL ? GLUE_ERR_OOM : iso20_signed_info_bytes(&header->Signature.SignedInfo, buf, &len);
      if (err == 0) out_b64(buf, len);
    } else {
      out_str("null");
    }
  }
  if (err == 0) {
    out_raw(",", 1);
    out_key("decoded");
    err = iso20_out_document(doc);
  }
  if (err == 0) out_raw("}", 1);
  free(exi);
  free(doc);
  return err;
}

// ================================================================ entry points

// Decodes an EXI document. schema: 2 (ISO 15118-2) or 20 (ISO 15118-20).
// Returns the JSON length (read it at v2g_result_ptr()) or a negative error.
__attribute__((export_name("v2g_decode"))) int v2g_decode(uint32_t schema, const uint8_t* in,
                                                           uint32_t len) {
  out_reset();
  int err;
  if (schema == 2) {
    err = iso2_decode(in, len);
  } else if (schema == 20) {
    err = iso20_decode(in, len);
  } else {
    err = GLUE_ERR_SCHEMA;
  }
  return err != 0 ? err : out_finish();
}

// Encodes a message from a tag-length-value record. Returns the JSON length
// or a negative error.
__attribute__((export_name("v2g_encode"))) int v2g_encode(uint32_t schema, const uint8_t* rec,
                                                           uint32_t len) {
  out_reset();
  int err;
  if (schema == 2) {
    err = iso2_encode(rec, len);
  } else if (schema == 20) {
    err = iso20_encode(rec, len);
  } else {
    err = GLUE_ERR_SCHEMA;
  }
  return err != 0 ? err : out_finish();
}
