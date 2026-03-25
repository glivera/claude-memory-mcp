export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenCappedEntry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  similarity: number;
  project_id: string;
  memory_type: string;
  created_at: string;
}

export function truncateToTokenLimit(
  entries: TokenCappedEntry[],
  limit: number
): TokenCappedEntry[] {
  let totalTokens = 0;
  const result: TokenCappedEntry[] = [];

  for (const entry of entries) {
    const entryText = `${entry.title} ${entry.content}`;
    const entryTokens = countTokens(entryText);

    if (totalTokens + entryTokens <= limit) {
      totalTokens += entryTokens;
      result.push(entry);
    } else {
      const remaining = limit - totalTokens;
      if (remaining > 20) {
        const truncatedChars = remaining * 4;
        result.push({
          ...entry,
          content: entry.content.slice(0, truncatedChars) + ' [truncated]',
        });
      }
      break;
    }
  }

  return result;
}
