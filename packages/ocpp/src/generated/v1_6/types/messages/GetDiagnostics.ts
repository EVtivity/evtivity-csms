export interface GetDiagnostics {
  location: string;
  retries?: number;
  retryInterval?: number;
  startTime?: string;
  stopTime?: string;
}
