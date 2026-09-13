/** Irreversible fence shared by independent driver and guest input channels. */
export class SafetyLatch {
  private error: Error | undefined;
  constructor(private readonly onTrip: (error: Error) => void = () => {}) {}
  trip(error: unknown): void {
    if (this.error) return;
    this.error = error instanceof Error ? error : new Error(String(error));
    this.onTrip(this.error);
  }
  check(): void {
    if (this.error) throw this.error;
  }
}
