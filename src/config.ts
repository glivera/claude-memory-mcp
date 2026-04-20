import { z } from 'zod';

const configSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  EMBEDDING_MODEL: z.string().default('qwen3-embedding-0.6b'),
  SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.25),
  RECALL_TOKEN_CAP: z.coerce.number().positive().default(2000),
  DEFAULT_RECALL_LIMIT: z.coerce.number().positive().max(20).default(5),
});

export type Config = z.infer<typeof configSchema>;

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    throw new Error(`Invalid configuration: ${missing}`);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

export function resetConfigCache(): void {
  cachedConfig = null;
}
