// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deterministic category hints for the router, in the six CSMS languages
 * (en, de, es, ko, zh, zh-TW). The router model decides, but a reasoning
 * router model can run out of output budget before it answers (more often for
 * a non-English message), and it can miss a category. These hints keep the
 * categories a message clearly names: a station command (a station plus a
 * command verb), sessions, tariffs and drivers.
 *
 * Terms are matched case-insensitively as substrings, so inflected forms
 * ("Ladevorgänge", "sesiones") match their stem. Keep each term specific
 * enough that it does not occur inside unrelated words.
 */

/** Both OCPP command categories: the router cannot know a station's protocol version. */
export const OCPP_COMMAND_CATEGORIES = ['OCPP 2.1 Commands', 'OCPP 1.6 Commands'] as const;

/** A charging station named in the message. */
const STATION_TERMS = [
  // en
  'station',
  'charger',
  'charge point',
  'chargepoint',
  'evse',
  'connector',
  // de (Station is covered by "station")
  'ladesäule',
  'ladepunkt',
  'wallbox',
  'stecker',
  // es
  'estación',
  'estacion',
  'cargador',
  'punto de carga',
  'conector',
  // ko
  '충전소',
  '충전기',
  '스테이션',
  '커넥터',
  // zh
  '充电站',
  '充电桩',
  '充电器',
  '连接器',
  '枪',
  // zh-TW
  '充電站',
  '充電樁',
  '充電器',
  '連接器',
];

/** An OCPP station ID such as IOCHARGER-002 or CS-0001: letters, a dash or underscore, digits. */
const STATION_ID = /\b[A-Za-z][A-Za-z0-9]*[-_][A-Za-z0-9-_]*\d[A-Za-z0-9-_]*\b/;

/**
 * A command a station runs: reset, unlock, start or stop, availability, charging
 * profile. Plain availability words (available, verfügbar, 可用) are left out:
 * they are as common in questions about status as in commands.
 */
const COMMAND_TERMS = [
  // en
  'reset',
  'reboot',
  'restart',
  'unlock',
  'remote start',
  'remote stop',
  'start charging',
  'stop charging',
  'start a session',
  'start a charging',
  'stop the session',
  'stop the charging',
  'stop session',
  'stop transaction',
  'start transaction',
  'make available',
  'make unavailable',
  'set available',
  'set unavailable',
  'inoperative',
  'charging profile',
  'trigger message',
  'clear cache',
  // de
  'zurücksetzen',
  'zurückzusetzen',
  'neu starten',
  'neustart',
  'neu zu starten',
  'entsperren',
  'entriegeln',
  'starte ',
  'starten',
  'stoppe ',
  'stoppen',
  'beende ',
  'beenden',
  'außer betrieb',
  'verfügbar machen',
  'verfügbar setzen',
  'ladeprofil',
  // es
  'reiniciar',
  'reinicia',
  'reinicio',
  'restablecer',
  'restablece',
  'desbloquear',
  'desbloquea',
  'iniciar',
  'inicia ',
  'detener',
  'detén',
  'deten ',
  'parar',
  'fuera de servicio',
  'poner disponible',
  'poner en servicio',
  'perfil de carga',
  // ko
  '리셋',
  '재설정',
  '재시작',
  '재부팅',
  '초기화',
  '잠금 해제',
  '잠금해제',
  '시작',
  '중지',
  '정지',
  '종료',
  '충전 프로필',
  '사용 불가로',
  '사용 가능으로',
  // zh
  '重置',
  '重启',
  '复位',
  '解锁',
  '启动',
  '开始充电',
  '停止',
  '充电配置',
  '设为可用',
  '设为不可用',
  '停用',
  // zh-TW
  '重新啟動',
  '重啟',
  '解鎖',
  '啟動',
  '開始充電',
  '充電設定檔',
  '設為可用',
  '設為不可用',
];

/** Category terms that need no station: the tag and the words that name it. */
const CATEGORY_TERMS: readonly { tag: string; terms: readonly string[] }[] = [
  {
    tag: 'Sessions',
    terms: [
      'session',
      'transaction',
      'ladevorgang',
      'ladevorgänge',
      'ladesitzung',
      'sitzung',
      'sesión',
      'sesion',
      'transacción',
      '세션',
      '충전 내역',
      '会话',
      '充电记录',
      '交易',
      '工作階段',
      '充電紀錄',
    ],
  },
  {
    tag: 'Pricing',
    terms: [
      'tariff',
      'pricing',
      'price',
      'tarif',
      'preis',
      'tarifa',
      'precio',
      '요금',
      '가격',
      '资费',
      '费率',
      '价格',
      '定价',
      '电价',
      '費率',
      '價格',
      '計費',
      '資費',
      '電價',
    ],
  },
  {
    tag: 'Drivers',
    terms: [
      'driver',
      'fahrer',
      'conductor',
      '운전자',
      '드라이버',
      '驾驶员',
      '司机',
      '駕駛員',
      '司機',
    ],
  },
];

function includesAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(term));
}

/** True when the message names a station and a command for it, in any CSMS language. */
export function isStationCommand(message: string): boolean {
  const text = message.toLowerCase();
  const namesStation = STATION_ID.test(message) || includesAny(text, STATION_TERMS);
  return namesStation && includesAny(text, COMMAND_TERMS);
}

/**
 * The categories a message clearly names, among the known tags: both OCPP
 * command categories for a station command, then sessions, tariffs and
 * drivers.
 */
export function keywordCategories(message: string, known: ReadonlySet<string>): string[] {
  const text = message.toLowerCase();
  const out: string[] = [];
  if (isStationCommand(message)) out.push(...OCPP_COMMAND_CATEGORIES);
  for (const { tag, terms } of CATEGORY_TERMS) {
    if (includesAny(text, terms)) out.push(tag);
  }
  return out.filter((tag) => known.has(tag));
}
