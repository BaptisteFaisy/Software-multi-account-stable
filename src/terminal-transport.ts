export class TerminalInputBuffer {
  private readonly pending = new Map<number, string[]>();

  append(id: number, data: string) {
    if (!data) return;
    const chunks = this.pending.get(id) ?? [];
    chunks.push(data);
    this.pending.set(id, chunks);
  }

  take(id: number) {
    const chunks = this.pending.get(id);
    this.pending.delete(id);
    return chunks?.join("") ?? "";
  }

  move(from: number, to: number) {
    if (from === to) return;
    const source = this.pending.get(from);
    if (!source?.length) return;
    const destination = this.pending.get(to) ?? [];
    this.pending.delete(from);
    this.pending.set(to, [...source, ...destination]);
  }

  clear(id: number) {
    this.pending.delete(id);
  }
}

export const terminalTransportErrorMessage = (baseUrl: string, error: unknown) => {
  const raw = String(error);
  if (
    error instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(raw)
  ) {
    return `Serveur terminal inaccessible (${baseUrl}). Reconnexion en cours...`;
  }
  return raw;
};
