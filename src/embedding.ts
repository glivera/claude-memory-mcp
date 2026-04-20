import { getConfig } from './config.js';
import { EmbeddingError } from './errors.js';

interface OllamaEmbedResponse {
  embedding: number[];
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const config = getConfig();

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${config.OLLAMA_URL}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.EMBEDDING_MODEL,
          prompt: text,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        const err = { status: response.status, message: body };
        if (attempt === 0 && isRetryable(err)) continue;
        throw err;
      }

      const data = (await response.json()) as OllamaEmbedResponse;
      return data.embedding;
    } catch (err) {
      lastError = err;
      if (attempt === 0 && isRetryable(err)) {
        continue;
      }
      break;
    }
  }

  throw new EmbeddingError(
    `Failed to generate embedding: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError }
  );
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    return [429, 500, 502, 503].includes(status);
  }
  return false;
}
