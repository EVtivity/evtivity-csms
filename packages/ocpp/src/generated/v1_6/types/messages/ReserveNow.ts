export interface ReserveNow {
  connectorId: number;
  expiryDate: string;
  idTag: string;
  parentIdTag?: string;
  reservationId: number;
}
