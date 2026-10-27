export interface ClipboardAdapter {
  writeText(text: string): void;
  readText(): string | Promise<string>;
}

export class ClipboardService {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly clipboard: ClipboardAdapter) {}

  copy(resolveText: () => Promise<string> | string): Promise<void> {
    const operation = this.queue.then(async () => {
      const text = await resolveText();
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("Không có nội dung để copy.");
      }
      this.clipboard.writeText(text);
      if (await this.clipboard.readText() !== text) {
        throw new Error("Clipboard không chứa đúng nội dung vừa copy.");
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
