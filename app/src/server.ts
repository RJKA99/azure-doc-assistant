import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SearchIndexClient, AzureKeyCredential } from "@azure/search-documents";
import { z } from "zod";
import { retrieveRelevantChunks, buildRagPrompt, DEFAULT_INDEX_NAME, type RetrievedChunk } from "./rag.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const serviceApiKey = process.env.SERVICE_API_KEY;
const MODEL = "claude-sonnet-4-5";

const app = express();
app.use(express.json());

function checkApiKey(req: express.Request, res: express.Response): boolean {
  if (serviceApiKey && req.header("x-api-key") !== serviceApiKey) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

async function answerFromDocuments(
  question: string,
  indexName: string
): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const chunks = await retrieveRelevantChunks(question, indexName);
  const prompt = buildRagPrompt(question, chunks);

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  return {
    answer: textBlock?.type === "text" ? textBlock.text : "",
    sources: chunks,
  };
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/indexes", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  try {
    const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const apiKey = process.env.AZURE_SEARCH_API_KEY;
    if (!endpoint || !apiKey) throw new Error("AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_API_KEY must be set");

    const indexClient = new SearchIndexClient(endpoint, new AzureKeyCredential(apiKey));
    const names: string[] = [];
    for await (const index of indexClient.listIndexes()) {
      names.push(index.name);
    }
    res.json({ indexes: names });
  } catch (err) {
    console.error("/indexes failed:", err);
    res.status(502).json({ error: "upstream request failed" });
  }
});

app.post("/ask", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { question, index } = req.body ?? {};
  if (typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "question (string) is required" });
    return;
  }
  const indexName = typeof index === "string" && index.trim() !== "" ? index : DEFAULT_INDEX_NAME;

  try {
    const { answer, sources } = await answerFromDocuments(question, indexName);
    res.json({ answer, sources: sources.map((s) => ({ source: s.source, score: s.score })) });
  } catch (err) {
    console.error("/ask failed:", err);
    res.status(502).json({ error: "upstream request failed" });
  }
});

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "azure-doc-assistant", version: "0.1.0" });

  server.registerTool(
    "ask_documents",
    {
      title: "Ask documents",
      description:
        "Answers a question using retrieval-augmented generation over an ingested document corpus, " +
        "backed by Azure AI Search and Claude. Pass `index` to pick which ingested corpus to query " +
        "(see the /indexes endpoint for available names); defaults to the job-hunt-data corpus.",
      inputSchema: {
        question: z.string().describe("The question to answer from the document corpus"),
        index: z.string().optional().describe(`Which ingested index to query (default: "${DEFAULT_INDEX_NAME}")`),
      },
    },
    async ({ question, index }) => {
      const { answer, sources } = await answerFromDocuments(question, index ?? DEFAULT_INDEX_NAME);
      const sourceList = sources.map((s) => s.source).join(", ") || "no matching sources";
      return {
        content: [{ type: "text", text: `${answer}\n\n(Lähteet: ${sourceList})` }],
      };
    }
  );

  return server;
}

app.post("/mcp", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("/mcp failed:", err);
    if (!res.headersSent) {
      res.status(502).json({ error: "upstream request failed" });
    }
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`listening on port ${port}`);
});
