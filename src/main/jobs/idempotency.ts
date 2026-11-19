/**
 * Local attempt fence: never re-execute the same job attempt after a terminal report.
 */
export class JobAttemptIdempotencyStore {
  private readonly terminal = new Map<string, { status: string; at: string }>();

  key(jobId: string, attemptId: string): string {
    return `${jobId}::${attemptId}`;
  }

  hasTerminal(jobId: string, attemptId: string): boolean {
    return this.terminal.has(this.key(jobId, attemptId));
  }

  markTerminal(jobId: string, attemptId: string, status: string): void {
    this.terminal.set(this.key(jobId, attemptId), {
      status,
      at: new Date().toISOString(),
    });
  }

  get(jobId: string, attemptId: string): { status: string; at: string } | null {
    return this.terminal.get(this.key(jobId, attemptId)) ?? null;
  }

  clear(): void {
    this.terminal.clear();
  }
}
