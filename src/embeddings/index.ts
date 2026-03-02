/**
 * Embeddings Module
 * Provides embedding function interface and registry for vector search
 *
 * Default: Nomic Embed Text v1 (local, no API key needed)
 * Same approach as claude-mem's ChromaDB (local sentence-transformers model)
 */

export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * No-op embedder that returns an empty array
 * Used when embeddings are disabled or not configured
 */
export const noopEmbedder: EmbedFn = async (_text: string): Promise<number[]> => {
  return [];
};

export { createNomicEmbedder, createNomicQueryEmbedder } from './nomic.js';
