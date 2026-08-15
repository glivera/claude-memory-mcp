export function logToolCall(tool: string, args: any, startMs: number, error?: unknown): void {
  const ms = Date.now() - startMs;
  const project = args?.project_id ?? '-';
  const id = args?.memory_id ?? '-';
  if (error === undefined) {
    console.error(`[memory-mcp] ${new Date().toISOString()} tool=${tool} project=${project} id=${id} ms=${ms} ok`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[memory-mcp] ${new Date().toISOString()} tool=${tool} project=${project} id=${id} ms=${ms} error="${message}"`);
  }
}
