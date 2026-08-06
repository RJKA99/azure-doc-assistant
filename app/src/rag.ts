import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";

export const EMBEDDING_DIMENSIONS = 384;
export const SEARCH_INDEX_NAME = "documents";

let embedder: FeatureExtractionPipeline | null = null;

export async function embed(text: string): Promise<number[]> {
  if (!embedder) {
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export interface DocumentChunk {
  id: string;
  content: string;
  source: string;
  embedding: number[];
}

export function chunkText(text: string, source: string, chunkSize = 800, overlap = 150): DocumentChunk[] {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks: DocumentChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < clean.length) {
    const end = Math.min(start + chunkSize, clean.length);
    const content = clean.slice(start, end);
    if (content.trim().length > 0) {
      chunks.push({
        id: `${source}-${index}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
        content,
        source,
        embedding: [],
      });
      index += 1;
    }
    if (end === clean.length) break;
    start = end - overlap;
  }

  return chunks;
}

export function getSearchClient(): SearchClient<DocumentChunk> {
  const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const apiKey = process.env.AZURE_SEARCH_API_KEY;
  if (!endpoint || !apiKey) {
    throw new Error("AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_API_KEY must be set");
  }
  return new SearchClient<DocumentChunk>(endpoint, SEARCH_INDEX_NAME, new AzureKeyCredential(apiKey));
}

export interface RetrievedChunk {
  content: string;
  source: string;
  score: number;
}

export async function retrieveRelevantChunks(question: string, topK = 4): Promise<RetrievedChunk[]> {
  const queryVector = await embed(question);
  const client = getSearchClient();

  const results = await client.search(question, {
    vectorSearchOptions: {
      queries: [
        {
          kind: "vector",
          vector: queryVector,
          fields: ["embedding"],
          kNearestNeighborsCount: topK,
        },
      ],
    },
    select: ["content", "source"],
    top: topK,
  });

  const chunks: RetrievedChunk[] = [];
  for await (const result of results.results) {
    chunks.push({
      content: result.document.content,
      source: result.document.source,
      score: result.score ?? 0,
    });
  }
  return chunks;
}

export function buildRagPrompt(question: string, chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return question;
  }
  const context = chunks
    .map((c, i) => `[Lähde ${i + 1}: ${c.source}]\n${c.content}`)
    .join("\n\n");

  return `Vastaa kysymykseen alla olevan kontekstin perusteella. Jos konteksti ei sisällä vastausta, sano niin selkeästi äläkä keksi tietoa.

KONTEKSTI:
${context}

KYSYMYS:
${question}`;
}
