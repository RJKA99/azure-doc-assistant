import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const serviceApiKey = process.env.SERVICE_API_KEY;

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/ask", async (req, res) => {
  if (serviceApiKey && req.header("x-api-key") !== serviceApiKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const { question } = req.body ?? {};
  if (typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: "question (string) is required" });
    return;
  }

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: question }],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  res.json({ answer: textBlock?.type === "text" ? textBlock.text : "" });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`listening on port ${port}`);
});
