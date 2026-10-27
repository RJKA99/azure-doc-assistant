import { readFileSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { PDFParse } from "pdf-parse";
import {
  SearchIndexClient,
  SearchClient,
  AzureKeyCredential,
} from "@azure/search-documents";
import { BlobServiceClient } from "@azure/storage-blob";
import { chunkText, embed, EMBEDDING_DIMENSIONS, SEARCH_INDEX_NAME } from "../src/rag.js";

const SOURCE_DIRS = [
  "/Users/robinkarlsson/Desktop/job-hunt-data/cover-letters",
  "/Users/robinkarlsson/Desktop/job-hunt-data/job-descriptions",
  "/Users/robinkarlsson/Desktop/job-hunt-data/cv",
];

async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const parser = new PDFParse({ data: readFileSync(filePath) });
    const { text } = await parser.getText();
    await parser.destroy();
    return text;
  }
  return readFileSync(filePath, "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 2000): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isThrottled = (err as { statusCode?: number }).statusCode === 503;
      if (!isThrottled || attempt === retries) throw err;
      console.warn(`  Rajoitettu (503), yritetään uudelleen ${delayMs}ms kuluttua...`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
  throw new Error("unreachable");
}

async function ensureIndex(endpoint: string, apiKey: string) {
  const indexClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));

  await indexClient.createOrUpdateIndex({
    name: SEARCH_INDEX_NAME,
    fields: [
      { name: "id", type: "Edm.String", key: true, filterable: true },
      { name: "content", type: "Edm.String", searchable: true },
      { name: "source", type: "Edm.String", filterable: true, searchable: true },
      {
        name: "embedding",
        type: "Collection(Edm.Single)",
        searchable: true,
        vectorSearchDimensions: EMBEDDING_DIMENSIONS,
        vectorSearchProfileName: "default-profile",
      },
    ],
    vectorSearch: {
      algorithms: [{ name: "default-algo", kind: "hnsw" }],
      profiles: [{ name: "default-profile", algorithmConfigurationName: "default-algo" }],
    },
  });
  console.log(`Index "${SEARCH_INDEX_NAME}" valmis.`);
}

async function main() {
  const searchEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
  const searchApiKey = process.env.AZURE_SEARCH_API_KEY;
  const storageConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (!searchEndpoint || !searchApiKey) {
    throw new Error("Aseta AZURE_SEARCH_ENDPOINT ja AZURE_SEARCH_API_KEY ympäristömuuttujiksi ennen ajoa.");
  }

  await ensureIndex(searchEndpoint, searchApiKey);
  const searchClient = new SearchClient(searchEndpoint, SEARCH_INDEX_NAME, new AzureKeyCredential(searchApiKey));

  let blobContainer;
  if (storageConnectionString) {
    const blobService = BlobServiceClient.fromConnectionString(storageConnectionString);
    blobContainer = blobService.getContainerClient("documents");
    await blobContainer.createIfNotExists();
  }

  const files: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for (const name of readdirSync(dir)) {
      const ext = extname(name).toLowerCase();
      if (ext === ".pdf" || ext === ".md") {
        files.push(join(dir, name));
      }
    }
  }

  console.log(`Löytyi ${files.length} dokumenttia.`);

  for (const filePath of files) {
    const name = basename(filePath);
    console.log(`Käsitellään: ${name}`);

    let text: string;
    try {
      text = await extractText(filePath);
    } catch (err) {
      console.warn(`  Ohitetaan (tekstin erotus epäonnistui): ${name}`, err);
      continue;
    }

    if (blobContainer) {
      const blockBlob = blobContainer.getBlockBlobClient(name);
      await blockBlob.uploadFile(filePath);
    }

    const chunks = chunkText(text, name);
    console.log(`  ${chunks.length} palaa`);

    for (const chunk of chunks) {
      chunk.embedding = await embed(chunk.content);
    }

    if (chunks.length > 0) {
      await withRetry(() => searchClient.mergeOrUploadDocuments(chunks));
    }

    await sleep(1000);
  }

  console.log("Valmis.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
