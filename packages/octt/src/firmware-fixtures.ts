// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

// Static test material for the secure firmware update tests (OCPP 2.1 L01).
// The signing certificates were issued by the simulator's factory
// ManufacturerRootCertificate (@evtivity/css lib/manufacturer-root.ts); the
// images were signed with the valid signing certificate's key (ECDSA P-256,
// SHA-256, DER signature, base64). No private key is kept.

/** <Configured signingCertificate>: valid firmware signing certificate (2026-2056). */
export const FIRMWARE_SIGNING_CERTIFICATE =
  '-----BEGIN CERTIFICATE-----\nMIICCjCCAa+gAwIBAgIQAaK3gqT+lGYQo12Esq94VDAKBggqhkjOPQQDAjBMMQsw\nCQYDVQQGEwJVUzERMA8GA1UEChMIRVZ0aXZpdHkxKjAoBgNVBAMTIUVWdGl2aXR5\nIENTUyBNYW51ZmFjdHVyZXIgUm9vdCBDQTAgFw0yNjAxMDEwMDAwMDBaGA8yMDU2\nMDEwMTAwMDAwMFowSDELMAkGA1UEBhMCVVMxETAPBgNVBAoTCEVWdGl2aXR5MSYw\nJAYDVQQDEx1FVnRpdml0eSBDU1MgRmlybXdhcmUgU2lnbmluZzBZMBMGByqGSM49\nAgEGCCqGSM49AwEHA0IABGHtbRmMr+H97T8ERauy9zzRwaK3vkt42waqSonJEmKA\nwa2cXj/yXQjSIeFjYKIYo3X7VwoaWCsD3Y63On2+BbCjdTBzMAwGA1UdEwEB/wQC\nMAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMDMB0GA1UdDgQW\nBBTd9cxcN6ONr0oZt3JnR6TZH6DcpTAfBgNVHSMEGDAWgBQaUJm5G+evgGiJOpDm\nSQYBs/q92zAKBggqhkjOPQQDAgNJADBGAiEAjiVE45B164bxjDW4cee7gzpwSaPi\nS/FZyzy0Pf/sYSECIQCvae/9dDRHqEcecmzC+I9O1dKqVres4Akj8RXRhJQG0A==\n-----END CERTIFICATE-----';

/** <Generated invalid firmware signingCertificate>: issued by the same root, expired in 2021. */
export const EXPIRED_FIRMWARE_SIGNING_CERTIFICATE =
  '-----BEGIN CERTIFICATE-----\nMIICETCCAbegAwIBAgIQAQLn9LdLLN4qMsBpEPWOUDAKBggqhkjOPQQDAjBMMQsw\nCQYDVQQGEwJVUzERMA8GA1UEChMIRVZ0aXZpdHkxKjAoBgNVBAMTIUVWdGl2aXR5\nIENTUyBNYW51ZmFjdHVyZXIgUm9vdCBDQTAeFw0yMDAxMDEwMDAwMDBaFw0yMTAx\nMDEwMDAwMDBaMFIxCzAJBgNVBAYTAlVTMREwDwYDVQQKEwhFVnRpdml0eTEwMC4G\nA1UEAxMnRVZ0aXZpdHkgQ1NTIEZpcm13YXJlIFNpZ25pbmcgKGV4cGlyZWQpMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEF2ALzK6TOvfxHX4kpZiUb0qxdWVJO1G5\nd498dnTkREAh9r1xDJ0t/L1cYpp38eMvHcoK4cWBQJVGaa0AVFwUeKN1MHMwDAYD\nVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwMw\nHQYDVR0OBBYEFOeNkguAEUeZgHsf/CRnnXz3Ob6AMB8GA1UdIwQYMBaAFBpQmbkb\n56+AaIk6kOZJBgGz+r3bMAoGCCqGSM49BAMCA0gAMEUCIQC3F9Pkl7whb6PZvonl\nHbEHuS/htlXYBqPXxlLAWe0WPgIgPVnYYWclu/ZO0jX65dA9Il8gcy6vrVWsEAEr\nUqW56MY=\n-----END CERTIFICATE-----';

/** Firmware image served at <Configured firmware_location> (base64). */
export const FIRMWARE_IMAGE_BASE64 =
  'eyJmb3JtYXQiOiJldnRpdml0eS1jc3MtZmlybXdhcmUiLCJ2ZXJzaW9uIjoiMi4wLjAifQo=';

/** <Configured signature> of FIRMWARE_IMAGE_BASE64. */
export const FIRMWARE_SIGNATURE =
  'MEQCICjVgCAFtKYG28pPdxwHOAeGSaDH+ca6zvHeMaiXxyUqAiAb/7HB56fzWDlW+kPdwJIpJPDzA5KeR3+sh5rPwZITBw==';

/**
 * Firmware image that fails the installation verification (no image payload),
 * signed with the valid signing certificate (<Configured invalid firmware location>).
 */
export const BROKEN_FIRMWARE_IMAGE_BASE64 =
  'eyJmb3JtYXQiOiJldnRpdml0eS1jc3MtZmlybXdhcmUiLCJ2ZXJzaW9uIjoiMi4wLjAtYnJva2VuIiwiaW1hZ2UiOm51bGx9Cg==';

/** Signature of BROKEN_FIRMWARE_IMAGE_BASE64. */
export const BROKEN_FIRMWARE_SIGNATURE =
  'MEQCIBhk0HZa0Spi98z9BeJX8ZYVTlFOrUmI7Rr0EEyCHMSeAiBN072P08jKnqHwA693ggise9Yb6UEONPattmH76M0JVA==';

/** <Configured invalid firmware signature>: a real signature, but not of the firmware file. */
export const INVALID_FIRMWARE_SIGNATURE =
  'MEUCIGb2mTUFtiZbx532kanM7D1L7ssIPLNk2qtHtObTeG/eAiEA52fcBJEZUiY/ELqGBsy/GdfCW1pTJQhL2CSE4biuPsc=';
