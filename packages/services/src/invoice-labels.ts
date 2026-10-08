// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

/**
 * Labels of the invoice PDF in the six supported languages. Like UI labels,
 * they are not operator-editable. The on-screen invoice uses the CSMS locale
 * files (`invoices.*`); keep the wording of both in step.
 */

export const INVOICE_LANGUAGES = ['en', 'de', 'es', 'ko', 'zh', 'zh-TW'] as const;
export type InvoiceLanguage = (typeof INVOICE_LANGUAGES)[number];

export interface InvoiceLabels {
  /** BCP 47 locale for numbers, amounts, and dates. */
  locale: string;
  title: string;
  /** Title of a credit note. */
  creditNoteTitle: string;
  billedTo: string;
  from: string;
  status: string;
  issued: string;
  due: string;
  statuses: Record<'draft' | 'issued' | 'paid' | 'void' | 'credited', string>;
  /** On a credit note: the invoice it credits. */
  creditsInvoice: string;
  /** On a credited invoice: the credit note that credited it. */
  creditedBy: string;
  /** The reason of a credit note. */
  reason: string;
  /** On a credit note of a paid invoice: the refund is made outside EVtivity. */
  creditNotePaidNote: string;
  /** Fleet invoice: the billed calendar month. */
  period: string;
  /** Fleet invoice bill-to block: the VAT or tax ID; "{id}" is replaced. */
  taxId: string;
  /** Fleet invoice: the subtotal row of a driver's sessions; "{driver}" is replaced. */
  driverSubtotal: string;
  /** Fleet invoice: the group of sessions whose driver was deleted. */
  unknownDriver: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  /** A tax rate value; "{rate}" is replaced with the number (formatTaxRatePercent). */
  taxRateValue: string;
  amount: string;
  taxSummary: string;
  netAmount: string;
  tax: string;
  grossAmount: string;
  subtotal: string;
  totalTax: string;
  total: string;
  amountsNote: string;
  kinds: Record<
    | 'energy'
    | 'time'
    | 'sessionFee'
    | 'idleFee'
    | 'reservationFee'
    | 'cancellationFee'
    | 'noShowFee',
    string
  >;
  /** "{date}" and "{kwh}" are replaced. */
  session: string;
  /** "{n}" and "{label}" are replaced. */
  segment: string;
  /** Fleet invoice idle fee line: "{label}" (kinds.idleFee) and "{minutes}" are replaced. */
  idleFeeMinutes: string;
}

export const INVOICE_LABELS: Record<InvoiceLanguage, InvoiceLabels> = {
  en: {
    locale: 'en-US',
    title: 'INVOICE',
    creditNoteTitle: 'CREDIT NOTE',
    billedTo: 'BILLED TO',
    from: 'FROM',
    status: 'Status',
    issued: 'Issued',
    due: 'Due',
    statuses: {
      draft: 'Draft',
      issued: 'Issued',
      paid: 'Paid',
      void: 'Void',
      credited: 'Credited',
    },
    creditsInvoice: 'Credits invoice',
    creditedBy: 'Credit note',
    reason: 'Reason',
    creditNotePaidNote: 'The credited invoice was paid. The amount is refunded separately.',
    period: 'Period',
    taxId: 'VAT ID: {id}',
    driverSubtotal: 'Subtotal {driver}',
    unknownDriver: 'Unknown driver',
    description: 'DESCRIPTION',
    quantity: 'QTY',
    unitPrice: 'UNIT PRICE',
    taxRate: 'TAX RATE',
    taxRateValue: '{rate}%',
    amount: 'AMOUNT',
    taxSummary: 'TAX SUMMARY',
    netAmount: 'Net amount',
    tax: 'Tax',
    grossAmount: 'Gross amount',
    subtotal: 'Subtotal (net)',
    totalTax: 'Total tax',
    total: 'Total',
    amountsNote: 'Unit prices and amounts exclude tax.',
    kinds: {
      energy: 'Energy',
      time: 'Charging time',
      sessionFee: 'Session fee',
      idleFee: 'Idle fee',
      reservationFee: 'Reservation fee',
      cancellationFee: 'Reservation cancellation fee',
      noShowFee: 'Reservation no-show fee',
    },
    session: 'Charging session {date} ({kwh} kWh)',
    segment: 'Segment {n}: {label}',
    idleFeeMinutes: '{label}, {minutes} min',
  },
  de: {
    locale: 'de-DE',
    title: 'RECHNUNG',
    creditNoteTitle: 'STORNORECHNUNG',
    billedTo: 'RECHNUNGSEMPFÄNGER',
    from: 'RECHNUNGSSTELLER',
    status: 'Status',
    issued: 'Rechnungsdatum',
    due: 'Fällig am',
    statuses: {
      draft: 'Entwurf',
      issued: 'Ausgestellt',
      paid: 'Bezahlt',
      void: 'Storniert',
      credited: 'Storniert (Stornorechnung)',
    },
    creditsInvoice: 'Zu Rechnung',
    creditedBy: 'Stornorechnung',
    reason: 'Grund',
    creditNotePaidNote:
      'Die stornierte Rechnung wurde bezahlt. Der Betrag wird gesondert erstattet.',
    period: 'Zeitraum',
    taxId: 'USt-IdNr.: {id}',
    driverSubtotal: 'Zwischensumme {driver}',
    unknownDriver: 'Unbekannter Fahrer',
    description: 'BESCHREIBUNG',
    quantity: 'MENGE',
    unitPrice: 'EINZELPREIS',
    taxRate: 'STEUERSATZ',
    taxRateValue: '{rate}\u00a0%',
    amount: 'BETRAG',
    taxSummary: 'STEUERAUFSTELLUNG',
    netAmount: 'Nettobetrag',
    tax: 'Steuer',
    grossAmount: 'Bruttobetrag',
    subtotal: 'Zwischensumme (netto)',
    totalTax: 'Steuer gesamt',
    total: 'Gesamtbetrag',
    amountsNote: 'Einzelpreise und Beträge ohne Steuer.',
    kinds: {
      energy: 'Energie',
      time: 'Ladezeit',
      sessionFee: 'Gebühr pro Vorgang',
      idleFee: 'Standgebühr',
      reservationFee: 'Reservierungsgebühr',
      cancellationFee: 'Stornogebühr Reservierung',
      noShowFee: 'Gebühr für nicht genutzte Reservierung',
    },
    session: 'Ladevorgang {date} ({kwh} kWh)',
    segment: 'Abschnitt {n}: {label}',
    idleFeeMinutes: '{label}, {minutes} Min.',
  },
  es: {
    locale: 'es-ES',
    title: 'FACTURA',
    creditNoteTitle: 'NOTA DE CRÉDITO',
    billedTo: 'FACTURADO A',
    from: 'EMISOR',
    status: 'Estado',
    issued: 'Emitida',
    due: 'Vencimiento',
    statuses: {
      draft: 'Borrador',
      issued: 'Emitida',
      paid: 'Pagada',
      void: 'Anulada',
      credited: 'Acreditada',
    },
    creditsInvoice: 'Acredita la factura',
    creditedBy: 'Nota de crédito',
    reason: 'Motivo',
    creditNotePaidNote: 'La factura acreditada fue pagada. El importe se reembolsa por separado.',
    period: 'Periodo',
    taxId: 'NIF/CIF: {id}',
    driverSubtotal: 'Subtotal {driver}',
    unknownDriver: 'Conductor desconocido',
    description: 'DESCRIPCIÓN',
    quantity: 'CANT.',
    unitPrice: 'PRECIO UNITARIO',
    taxRate: 'TIPO IMPOSITIVO',
    taxRateValue: '{rate}\u00a0%',
    amount: 'IMPORTE',
    taxSummary: 'DESGLOSE DE IMPUESTOS',
    netAmount: 'Base imponible',
    tax: 'Impuesto',
    grossAmount: 'Importe bruto',
    subtotal: 'Subtotal (base imponible)',
    totalTax: 'Total impuestos',
    total: 'Total',
    amountsNote: 'Los precios unitarios y los importes no incluyen impuestos.',
    kinds: {
      energy: 'Energía',
      time: 'Tiempo de carga',
      sessionFee: 'Tarifa por sesión',
      idleFee: 'Tarifa de inactividad',
      reservationFee: 'Tarifa de reserva',
      cancellationFee: 'Tarifa de cancelación de reserva',
      noShowFee: 'Tarifa por reserva no utilizada',
    },
    session: 'Sesión de carga {date} ({kwh} kWh)',
    segment: 'Tramo {n}: {label}',
    idleFeeMinutes: '{label}, {minutes} min',
  },
  ko: {
    locale: 'ko-KR',
    title: '청구서',
    creditNoteTitle: '크레딧 노트',
    billedTo: '청구 대상',
    from: '발행처',
    status: '상태',
    issued: '발행일',
    due: '납부 기한',
    statuses: {
      draft: '초안',
      issued: '발행됨',
      paid: '결제됨',
      void: '무효',
      credited: '크레딧 처리됨',
    },
    creditsInvoice: '대상 청구서',
    creditedBy: '크레딧 노트',
    reason: '사유',
    creditNotePaidNote: '크레딧 처리된 청구서는 결제되었습니다. 금액은 별도로 환불됩니다.',
    period: '기간',
    taxId: '사업자등록번호: {id}',
    driverSubtotal: '{driver} 소계',
    unknownDriver: '알 수 없는 드라이버',
    description: '설명',
    quantity: '수량',
    unitPrice: '단가',
    taxRate: '세율',
    taxRateValue: '{rate}%',
    amount: '금액',
    taxSummary: '세금 내역',
    netAmount: '공급가액',
    tax: '세액',
    grossAmount: '합계 금액',
    subtotal: '소계 (공급가액)',
    totalTax: '세액 합계',
    total: '총액',
    amountsNote: '단가와 금액은 세금 별도입니다.',
    kinds: {
      energy: '에너지',
      time: '충전 시간',
      sessionFee: '세션 요금',
      idleFee: '유휴 요금',
      reservationFee: '예약 요금',
      cancellationFee: '예약 취소 수수료',
      noShowFee: '예약 노쇼 수수료',
    },
    session: '충전 세션 {date} ({kwh} kWh)',
    segment: '구간 {n}: {label}',
    idleFeeMinutes: '{label}, {minutes}분',
  },
  zh: {
    locale: 'zh-CN',
    title: '发票',
    creditNoteTitle: '贷项通知单',
    billedTo: '账单对象',
    from: '开票方',
    status: '状态',
    issued: '开具日期',
    due: '到期日',
    statuses: {
      draft: '草稿',
      issued: '已开具',
      paid: '已支付',
      void: '已作废',
      credited: '已贷记',
    },
    creditsInvoice: '对应发票',
    creditedBy: '贷项通知单',
    reason: '原因',
    creditNotePaidNote: '被贷记的发票已支付。款项将另行退还。',
    period: '账期',
    taxId: '税号：{id}',
    driverSubtotal: '{driver} 小计',
    unknownDriver: '未知驾驶员',
    description: '描述',
    quantity: '数量',
    unitPrice: '单价',
    taxRate: '税率',
    taxRateValue: '{rate}%',
    amount: '金额',
    taxSummary: '税额明细',
    netAmount: '不含税金额',
    tax: '税额',
    grossAmount: '含税金额',
    subtotal: '小计（不含税）',
    totalTax: '税额合计',
    total: '合计',
    amountsNote: '单价和金额均不含税。',
    kinds: {
      energy: '电量',
      time: '充电时长',
      sessionFee: '每次会话费用',
      idleFee: '闲置费',
      reservationFee: '预约保留费',
      cancellationFee: '预约取消费',
      noShowFee: '预约未到场费',
    },
    session: '充电会话 {date}（{kwh} kWh）',
    segment: '第 {n} 段：{label}',
    idleFeeMinutes: '{label}，{minutes} 分钟',
  },
  'zh-TW': {
    locale: 'zh-TW',
    title: '發票',
    creditNoteTitle: '貸項通知單',
    billedTo: '帳單對象',
    from: '開立方',
    status: '狀態',
    issued: '開立日期',
    due: '到期日',
    statuses: {
      draft: '草稿',
      issued: '已開立',
      paid: '已付款',
      void: '已作廢',
      credited: '已貸記',
    },
    creditsInvoice: '對應發票',
    creditedBy: '貸項通知單',
    reason: '原因',
    creditNotePaidNote: '被貸記的發票已付款。款項將另行退還。',
    period: '帳期',
    taxId: '統一編號：{id}',
    driverSubtotal: '{driver} 小計',
    unknownDriver: '未知駕駛員',
    description: '描述',
    quantity: '數量',
    unitPrice: '單價',
    taxRate: '稅率',
    taxRateValue: '{rate}%',
    amount: '金額',
    taxSummary: '稅額明細',
    netAmount: '未稅金額',
    tax: '稅額',
    grossAmount: '含稅金額',
    subtotal: '小計（未稅）',
    totalTax: '稅額合計',
    total: '合計',
    amountsNote: '單價與金額均未稅。',
    kinds: {
      energy: '電量',
      time: '充電時長',
      sessionFee: '每次會話費用',
      idleFee: '閒置費',
      reservationFee: '預約保留費',
      cancellationFee: '預約取消費',
      noShowFee: '預約未到場費',
    },
    session: '充電會話 {date}（{kwh} kWh）',
    segment: '第 {n} 段：{label}',
    idleFeeMinutes: '{label}，{minutes} 分鐘',
  },
};

export function isInvoiceLanguage(value: unknown): value is InvoiceLanguage {
  return typeof value === 'string' && (INVOICE_LANGUAGES as readonly string[]).includes(value);
}

type ComponentKind = keyof InvoiceLabels['kinds'];

function isComponentKind(value: unknown): value is ComponentKind {
  return (
    value === 'energy' ||
    value === 'time' ||
    value === 'sessionFee' ||
    value === 'idleFee' ||
    value === 'reservationFee' ||
    value === 'cancellationFee' ||
    value === 'noShowFee'
  );
}

/**
 * Localized description of a line item from its metadata (`kind`, `segment`,
 * `sessionDate`, `energyWh`). Falls back to the stored English description
 * when the metadata does not say what the line bills.
 */
export function describeLineItem(
  labels: InvoiceLabels,
  description: string,
  metadata: unknown,
): string {
  if (metadata == null || typeof metadata !== 'object') return description;
  const meta = metadata as Record<string, unknown>;
  const kind = meta['kind'];

  if (kind === 'session') {
    const energyWh = typeof meta['energyWh'] === 'number' ? meta['energyWh'] : 0;
    const kwh = new Intl.NumberFormat(labels.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(energyWh / 1000);
    const rawDate = typeof meta['sessionDate'] === 'string' ? meta['sessionDate'] : '';
    const parsed = new Date(`${rawDate}T00:00:00Z`);
    const date = Number.isNaN(parsed.getTime())
      ? rawDate
      : new Intl.DateTimeFormat(labels.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
          parsed,
        );
    const session = labels.session.replace('{date}', date).replace('{kwh}', kwh);
    // A fleet invoice line names the station; its driver heads the group.
    const station = typeof meta['stationName'] === 'string' ? meta['stationName'] : '';
    return station !== '' ? `${session} · ${station}` : session;
  }

  if (!isComponentKind(kind)) return description;
  const label = labels.kinds[kind];
  // A fleet invoice shows a session's idle fee as its own line with the
  // billable idle minutes.
  if (kind === 'idleFee' && typeof meta['idleMinutes'] === 'number') {
    const minutes = new Intl.NumberFormat(labels.locale, { maximumFractionDigits: 0 }).format(
      meta['idleMinutes'],
    );
    return labels.idleFeeMinutes.replace('{label}', label).replace('{minutes}', minutes);
  }
  const segment = meta['segment'];
  return typeof segment === 'number'
    ? labels.segment.replace('{n}', String(segment)).replace('{label}', label)
    : label;
}
