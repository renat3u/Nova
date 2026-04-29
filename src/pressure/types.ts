// Alice baseline reference: pressure model adapted for Nova QQ runtime.

export interface PressureResult {
  total: number;
  contributions: Record<string, number>;
}
