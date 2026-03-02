/**
 * Nomic Embed Text v1 Adapter
 * Runs locally via @huggingface/transformers — no API key needed.
 * Produces 768-dimensional embeddings, same local approach as claude-mem's ChromaDB.
 */

import type { EmbedFn } from './index.js';

let pipelineInstance: any = null;

async function getPipeline() {
  if (!pipelineInstance) {
    const { pipeline } = await import('@huggingface/transformers');
    pipelineInstance = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1', {
      dtype: 'fp32',
    });
  }
  return pipelineInstance;
}

export function createNomicEmbedder(): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const pipe = await getPipeline();
    // Nomic recommends prefixing with "search_document: " for documents
    // and "search_query: " for queries. For storage, use document prefix.
    const output = await pipe(`search_document: ${text}`, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  };
}

/**
 * Creates an embedder specifically for search queries.
 * Uses the "search_query: " prefix as recommended by Nomic.
 */
export function createNomicQueryEmbedder(): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const pipe = await getPipeline();
    const output = await pipe(`search_query: ${text}`, {
      pooling: 'mean',
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  };
}
