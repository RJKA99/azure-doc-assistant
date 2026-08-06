import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { retrieveRelevantChunks, buildRagPrompt, type RetrievedChunk } from "./rag.js";

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

async function answerFromDocuments(question: string): Promise<{ answer: string; sources: RetrievedChunk[] }> {
  const chunks = await retrieveRelevantChunks(question);
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

app.post("/ask", async (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { question } = req.body ?? {};
  if (typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "question (string) is required" });
    return;
  }

  const { answer, sources } = await answerFromDocuments(question);
  res.json({ answer, sources: sources.map((s) => ({ source: s.source, score: s.score })) });
});

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "azure-doc-assistant", version: "0.1.0" });

  server.registerTool(
    "ask_documents",
    {
      title: "Ask documents",
      description:
        "Answers a question using retrieval-augmented generation over the ingested document corpus " +
        "(job applications, CVs, job descriptions), backed by Azure AI Search and Claude.",
      inputSchema: { question: z.string().describe("The question to answer from the document corpus") },
    },
    async ({ question }) => {
      const { answer, sources } = await answerFromDocuments(question);
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

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`listening on port ${port}`);
});
