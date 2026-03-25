import OpenAI from 'openai';
import { getConfig } from './config.js';
import { EmbeddingError } from './errors.js';

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const config = getConfig();
  openaiClient = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
  });
  return openaiClient;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.embeddings.create({
        model: getConfig().EMBEDDING_MODEL,
        input: text,
        encoding_format: 'float',
      });
      return response.data[0].embedding;
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
  if (err instanceof OpenAI.APIError) {
    return [429, 500, 502, 503].includes(err.status);
  }
  return false;
}

export function resetOpenAIClient(): void {
  openaiClient = null;
}
