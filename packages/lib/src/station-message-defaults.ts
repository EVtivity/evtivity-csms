// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { StationMessageState } from './station-message.js';
import type { TariffSummaryLabels } from './currency.js';

/**
 * Languages station display messages are kept in. One template per state and
 * language lives in `station_message_templates`; the `stationMessage.language`
 * setting picks the language every station shows.
 */
export const STATION_MESSAGE_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'] as const;

export type StationMessageLanguage = (typeof STATION_MESSAGE_LANGUAGES)[number];

/** Used when the `stationMessage.language` setting is unset or invalid. */
export const DEFAULT_STATION_MESSAGE_LANGUAGE: StationMessageLanguage = 'en';

export function isStationMessageLanguage(value: unknown): value is StationMessageLanguage {
  return (
    typeof value === 'string' && (STATION_MESSAGE_LANGUAGES as readonly string[]).includes(value)
  );
}

/**
 * Default template bodies per language. Seeded on install and restored by the
 * reset endpoint. The tax note on the Available screen is template text, so
 * operators word it per jurisdiction ("inkl. 19 % MwSt.").
 */
export const STATION_MESSAGE_DEFAULTS: Record<
  StationMessageLanguage,
  Record<StationMessageState, string>
> = {
  en: {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}incl.{{else}}excl.{{/if}} {{taxRatePercent}}% tax\n{{/if}}Plug in to start',
    occupied: '{{brandLine}}\n{{stationOcppId}}\nTap card or open app\nto start charging',
    reserved:
      '{{brandLine}}\nReserved\n{{#if driverFirstName}}for {{driverFirstName}}{{/if}}\nuntil {{reservationExpiresAt}}',
    charging:
      '{{brandLine}}\nCharging\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\nCharging paused\n{{#if idleFeeRate}}Idle fee {{idleFeeRate}} after grace{{/if}}',
    discharging: '{{brandLine}}\nDischarging to grid\n{{energyKwh}} kWh sent\n{{costFormatted}}',
    faulted: '{{brandLine}}\nStation fault\nContact support\n{{supportPhone}}',
    unavailable: '{{brandLine}}\nTemporarily unavailable',
    payment_failed:
      'Payment declined.\nUpdate your card in the app and try again.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
    payment_required: 'Add a payment method\nin the app to start charging.\n{{companyName}}',
    guest_unauthorized: 'Guest payment not authorized.\nScan the QR code\nto restart checkout.',
    unauthorized: 'Tap your RFID card\nor scan the QR code\nto authorize charging.',
  },
  de: {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}inkl.{{else}}zzgl.{{/if}} {{taxRatePercent}} % MwSt.\n{{/if}}Zum Starten einstecken',
    occupied: '{{brandLine}}\n{{stationOcppId}}\nKarte vorhalten oder\nApp öffnen zum Laden',
    reserved:
      '{{brandLine}}\nReserviert\n{{#if driverFirstName}}für {{driverFirstName}}{{/if}}\nbis {{reservationExpiresAt}}',
    charging:
      '{{brandLine}}\nLädt\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\nLaden pausiert\n{{#if idleFeeRate}}Standgebühr {{idleFeeRate}} nach Karenzzeit{{/if}}',
    discharging:
      '{{brandLine}}\nRückspeisung ins Netz\n{{energyKwh}} kWh abgegeben\n{{costFormatted}}',
    faulted: '{{brandLine}}\nStörung\nSupport kontaktieren\n{{supportPhone}}',
    unavailable: '{{brandLine}}\nVorübergehend nicht verfügbar',
    payment_failed:
      'Zahlung abgelehnt.\nKarte in der App aktualisieren und erneut versuchen.\n{{#if supportPhone}}Support: {{supportPhone}}{{/if}}',
    payment_required: 'Zahlungsmittel in der App\nhinzufügen, um zu laden.\n{{companyName}}',
    guest_unauthorized: 'Gastzahlung nicht autorisiert.\nQR-Code scannen,\num neu zu starten.',
    unauthorized: 'RFID-Karte vorhalten\noder QR-Code scannen,\num das Laden freizugeben.',
  },
  es: {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}Impuestos incluidos{{else}}Impuestos no incluidos{{/if}} ({{taxRatePercent}} %)\n{{/if}}Conecte para iniciar',
    occupied: '{{brandLine}}\n{{stationOcppId}}\nAcerque su tarjeta o\nabra la app para cargar',
    reserved:
      '{{brandLine}}\nReservado\n{{#if driverFirstName}}para {{driverFirstName}}{{/if}}\nhasta {{reservationExpiresAt}}',
    charging:
      '{{brandLine}}\nCargando\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\nCarga en pausa\n{{#if idleFeeRate}}Tarifa por inactividad {{idleFeeRate}} tras el periodo de gracia{{/if}}',
    discharging:
      '{{brandLine}}\nDescargando a la red\n{{energyKwh}} kWh enviados\n{{costFormatted}}',
    faulted: '{{brandLine}}\nFallo en la estación\nContacte con soporte\n{{supportPhone}}',
    unavailable: '{{brandLine}}\nNo disponible temporalmente',
    payment_failed:
      'Pago rechazado.\nActualice su tarjeta en la app e inténtelo de nuevo.\n{{#if supportPhone}}Soporte: {{supportPhone}}{{/if}}',
    payment_required: 'Añada un método de pago\nen la app para cargar.\n{{companyName}}',
    guest_unauthorized:
      'Pago de invitado no autorizado.\nEscanee el código QR\npara reiniciar el pago.',
    unauthorized: 'Acerque su tarjeta RFID\no escanee el código QR\npara autorizar la carga.',
  },
  ko: {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}세금 {{taxRatePercent}}% 포함{{else}}세금 {{taxRatePercent}}% 별도{{/if}}\n{{/if}}플러그를 연결하여 시작',
    occupied: '{{brandLine}}\n{{stationOcppId}}\n카드를 태그하거나\n앱에서 충전을 시작하세요',
    reserved:
      '{{brandLine}}\n예약됨\n{{#if driverFirstName}}{{driverFirstName}}님{{/if}}\n{{reservationExpiresAt}}까지',
    charging:
      '{{brandLine}}\n충전 중\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\n충전 일시 중지\n{{#if idleFeeRate}}유예 시간 후 유휴 요금 {{idleFeeRate}}{{/if}}',
    discharging: '{{brandLine}}\n전력망으로 방전 중\n{{energyKwh}} kWh 송전\n{{costFormatted}}',
    faulted: '{{brandLine}}\n충전기 고장\n고객센터에 문의하세요\n{{supportPhone}}',
    unavailable: '{{brandLine}}\n일시적으로 사용 불가',
    payment_failed:
      '결제가 거절되었습니다.\n앱에서 카드를 업데이트한 후 다시 시도하세요.\n{{#if supportPhone}}고객센터: {{supportPhone}}{{/if}}',
    payment_required: '충전하려면 앱에서\n결제 수단을 추가하세요.\n{{companyName}}',
    guest_unauthorized:
      '게스트 결제가 승인되지 않았습니다.\nQR 코드를 스캔하여\n결제를 다시 시작하세요.',
    unauthorized: 'RFID 카드를 태그하거나\nQR 코드를 스캔하여\n충전을 승인하세요.',
  },
  zh: {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含税{{else}}不含税{{/if}}（税率 {{taxRatePercent}}%）\n{{/if}}插枪即可开始充电',
    occupied: '{{brandLine}}\n{{stationOcppId}}\n请刷卡或打开应用\n开始充电',
    reserved:
      '{{brandLine}}\n已预约\n{{#if driverFirstName}}预约人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}',
    charging:
      '{{brandLine}}\n充电中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\n充电已暂停\n{{#if idleFeeRate}}宽限期后收取占位费 {{idleFeeRate}}{{/if}}',
    discharging: '{{brandLine}}\n正在向电网放电\n已放电 {{energyKwh}} kWh\n{{costFormatted}}',
    faulted: '{{brandLine}}\n充电桩故障\n请联系客服\n{{supportPhone}}',
    unavailable: '{{brandLine}}\n暂时无法使用',
    payment_failed:
      '支付被拒绝。\n请在应用中更新银行卡后重试。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}',
    payment_required: '请在应用中添加\n支付方式后充电。\n{{companyName}}',
    guest_unauthorized: '访客支付未获授权。\n请扫描二维码\n重新结账。',
    unauthorized: '请刷 RFID 卡\n或扫描二维码\n授权充电。',
  },
  'zh-TW': {
    available:
      '{{brandLine}}\n{{stationOcppId}}\n{{pricingDisplay}}\n{{#if taxRatePercent}}{{#if pricesIncludeTax}}含稅{{else}}未稅{{/if}}（稅率 {{taxRatePercent}}%）\n{{/if}}插槍即可開始充電',
    occupied: '{{brandLine}}\n{{stationOcppId}}\n請感應卡片或開啟 App\n開始充電',
    reserved:
      '{{brandLine}}\n已預約\n{{#if driverFirstName}}預約人：{{driverFirstName}}{{/if}}\n保留至 {{reservationExpiresAt}}',
    charging:
      '{{brandLine}}\n充電中\n{{energyKwh}} kWh{{#if powerKw}} / {{powerKw}} kW{{/if}}\n{{costFormatted}}\n{{elapsedFormatted}}',
    suspended:
      '{{brandLine}}\n充電已暫停\n{{#if idleFeeRate}}寬限期後收取佔位費 {{idleFeeRate}}{{/if}}',
    discharging: '{{brandLine}}\n正在向電網放電\n已放電 {{energyKwh}} kWh\n{{costFormatted}}',
    faulted: '{{brandLine}}\n充電樁故障\n請聯絡客服\n{{supportPhone}}',
    unavailable: '{{brandLine}}\n暫時無法使用',
    payment_failed:
      '付款遭拒。\n請在 App 中更新信用卡後重試。\n{{#if supportPhone}}客服：{{supportPhone}}{{/if}}',
    payment_required: '請在 App 中新增\n付款方式後充電。\n{{companyName}}',
    guest_unauthorized: '訪客付款未獲授權。\n請掃描 QR 碼\n重新結帳。',
    unauthorized: '請感應 RFID 卡\n或掃描 QR 碼\n授權充電。',
  },
};

/**
 * Words of the `pricingDisplay` summary per language and
 * `stationMessage.pricingFormat`. Operators who want other words build the
 * line from the single price variables (`energyPrice`, `timePrice`,
 * `sessionFee`, `idleFee`) in the template instead.
 */
export const STATION_PRICE_SUMMARY_LABELS: Record<
  StationMessageLanguage,
  Record<'compact' | 'standard', TariffSummaryLabels>
> = {
  en: {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/min',
      session: '{price} session',
      idle: '{price}/min idle',
      separator: ' + ',
      free: 'Free',
    },
    standard: {
      energy: 'Energy: {price}/kWh',
      time: 'Time: {price}/min',
      session: 'Session: {price}',
      idle: 'Idle: {price}/min',
      separator: ' | ',
      free: 'Free',
    },
  },
  de: {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/Min.',
      session: '{price} pro Ladevorgang',
      idle: '{price}/Min. Standzeit',
      separator: ' + ',
      free: 'Kostenlos',
    },
    standard: {
      energy: 'Energie: {price}/kWh',
      time: 'Zeit: {price}/Min.',
      session: 'Ladevorgang: {price}',
      idle: 'Standzeit: {price}/Min.',
      separator: ' | ',
      free: 'Kostenlos',
    },
  },
  es: {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/min',
      session: '{price} por sesión',
      idle: '{price}/min inactivo',
      separator: ' + ',
      free: 'Gratis',
    },
    standard: {
      energy: 'Energía: {price}/kWh',
      time: 'Tiempo: {price}/min',
      session: 'Sesión: {price}',
      idle: 'Inactividad: {price}/min',
      separator: ' | ',
      free: 'Gratis',
    },
  },
  ko: {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/분',
      session: '세션 {price}',
      idle: '유휴 {price}/분',
      separator: ' + ',
      free: '무료',
    },
    standard: {
      energy: '에너지: {price}/kWh',
      time: '시간: {price}/분',
      session: '세션: {price}',
      idle: '유휴: {price}/분',
      separator: ' | ',
      free: '무료',
    },
  },
  zh: {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/分钟',
      session: '每次 {price}',
      idle: '占位费 {price}/分钟',
      separator: ' + ',
      free: '免费',
    },
    standard: {
      energy: '电量：{price}/kWh',
      time: '时长：{price}/分钟',
      session: '每次：{price}',
      idle: '占位费：{price}/分钟',
      separator: ' | ',
      free: '免费',
    },
  },
  'zh-TW': {
    compact: {
      energy: '{price}/kWh',
      time: '{price}/分鐘',
      session: '每次 {price}',
      idle: '佔位費 {price}/分鐘',
      separator: ' + ',
      free: '免費',
    },
    standard: {
      energy: '電量：{price}/kWh',
      time: '時長：{price}/分鐘',
      session: '每次：{price}',
      idle: '佔位費：{price}/分鐘',
      separator: ' | ',
      free: '免費',
    },
  },
};

/** Per-minute unit pattern for the `idleFeeRate` variable ("{price}/min"). */
export const STATION_PER_MINUTE_LABELS: Record<StationMessageLanguage, string> = {
  en: '{price}/min',
  de: '{price}/Min.',
  es: '{price}/min',
  ko: '{price}/분',
  zh: '{price}/分钟',
  'zh-TW': '{price}/分鐘',
};
