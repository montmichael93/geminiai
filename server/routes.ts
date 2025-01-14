import type { Express } from "express";
import { createServer, type Server } from "http";
import {
  GoogleGenerativeAI,
  type ChatSession,
  type GenerateContentResult,
} from "@google/generative-ai";
import { marked } from "marked";
import { setupEnvironment } from "./env";

// Set up environment variables
const env = setupEnvironment();
const genAI = new GoogleGenerativeAI(env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  generationConfig: {
    temperature: 0.9,
    topP: 1,
    topK: 1,
    maxOutputTokens: 2048,
  },
});

// Store chat sessions in memory
const chatSessions = new Map<string, ChatSession>();

// Format raw text into proper markdown
async function formatResponseToMarkdown(text: string | Promise<string>): Promise<string> {
  const resolvedText = await Promise.resolve(text);

  // Replace newlines and format headings/bullet points
  let processedText = resolvedText.replace(/\r\n/g, "\n");
  processedText = processedText.replace(/^([A-Za-z][A-Za-z\s]+):(\s*)/gm, "## $1$2");
  processedText = processedText.replace(/(?<=\n|^)([A-Za-z][A-Za-z\s]+):(?!\d)/gm, "### $1");
  processedText = processedText.replace(/^[•●○]\s*/gm, "* ");

  // Process paragraphs
  const paragraphs = processedText.split("\n\n").filter(Boolean);
  const formatted = paragraphs
    .map((p) => (p.startsWith("#") || p.startsWith("*") || p.startsWith("-") ? p : `${p}\n`))
    .join("\n\n");

  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  return marked.parse(formatted);
}

interface WebSource {
  uri: string;
  title: string;
}

interface GroundingChunk {
  web?: WebSource;
}

interface TextSegment {
  startIndex: number;
  endIndex: number;
  text: string;
}

interface GroundingSupport {
  segment: TextSegment;
  groundingChunkIndices: number[];
  confidenceScores: number[];
}

interface GroundingMetadata {
  groundingChunks: GroundingChunk[];
  groundingSupports: GroundingSupport[];
  searchEntryPoint?: any;
  webSearchQueries?: string[];
}

export function registerRoutes(app: Express): Server {
  // Search endpoint - creates a new chat session
  app.get("/api/search", async (req, res) => {
    try {
      const query = req.query.q as string;

      if (!query) {
        return res.status(400).json({ message: "Query parameter 'q' is required" });
      }

      // Create a new chat session with search capability
      const chat = model.startChat({
        tools: [
          {
            google_search: {}, // @ts-ignore
          },
        ],
      });

      // Generate content with search tool
      const result = await chat.sendMessage(query);
      const response = await result.response;
      console.log("Raw Google API Response:", JSON.stringify({ text: response.text(), candidates: response.candidates }, null, 2));

      const text = response.text();

      // Format the response text to proper markdown/HTML
      const formattedText = await formatResponseToMarkdown(text);

      // Extract sources from grounding metadata
      const sourceMap = new Map<string, { title: string; url: string; snippet: string }>();

      const metadata = response.candidates?.[0]?.groundingMetadata;
      if (metadata) {
        const chunks = metadata.groundingChunks || [];
        const supports = metadata.groundingSupports || [];

        chunks.forEach((chunk, index) => {
          if (chunk.web?.uri && chunk.web?.title) {
            const url = chunk.web.uri;
            if (!sourceMap.has(url)) {
              const snippets = supports
                .filter((support) => support.groundingChunkIndices.includes(index))
                .map((support) => support.segment.text)
                .join(" ");
              sourceMap.set(url, {
                title: chunk.web.title,
                url: url,
                snippet: snippets || "",
              });
            }
          }
        });
      }

      const sources = Array.from(sourceMap.values());

      const sessionId = Math.random().toString(36).substring(7); // generate random session ID
      chatSessions.set(sessionId, chat);

      res.json({
        sessionId,
        summary: formattedText,
        sources,
      });
    } catch (error: any) {
      console.error("Search error:", error);
      res.status(500).json({ message: error.message || "An error occurred while processing your search" });
    }
  });

  // Follow-up endpoint - continues existing chat session
  app.post("/api/follow-up", async (req, res) => {
    try {
      const { sessionId, query } = req.body;

      if (!sessionId || !query) {
        return res.status(400).json({ message: "Both sessionId and query are required" });
      }

      const chat = chatSessions.get(sessionId);
      if (!chat) {
        return res.status(404).json({ message: "Chat session not found" });
      }

      const result = await chat.sendMessage(query);
      const response = await result.response;
      console.log("Raw Google API Follow-up Response:", JSON.stringify({ text: response.text(), candidates: response.candidates }, null, 2));

      const text = response.text();

      // Format the response text to proper markdown/HTML
      const formattedText = await formatResponseToMarkdown(text);

      // Extract sources from grounding metadata
      const sourceMap = new Map<string, { title: string; url: string; snippet: string }>();

      const metadata = response.candidates?.[0]?.groundingMetadata;
      if (metadata) {
        const chunks = metadata.groundingChunks || [];
        const supports = metadata.groundingSupports || [];

        chunks.forEach((chunk, index) => {
          if (chunk.web?.uri && chunk.web?.title) {
            const url = chunk.web.uri;
            if (!sourceMap.has(url)) {
              const snippets = supports
                .filter((support) => support.groundingChunkIndices.includes(index))
                .map((support) => support.segment.text)
                .join(" ");
              sourceMap.set(url, {
                title: chunk.web.title,
                url: url,
                snippet: snippets || "",
              });
            }
          }
        });
      }

      const sources = Array.from(sourceMap.values());

      res.json({
        summary: formattedText,
        sources,
      });
    } catch (error: any) {
      console.error("Follow-up error:", error);
      res.status(500).json({ message: error.message || "An error occurred while processing your follow-up question" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
