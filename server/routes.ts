import type { Express } from "express";
import { createServer, type Server } from "http";
import { GoogleGenerativeAI, type ChatSession } from "@google/generative-ai";
import { marked } from "marked";
import { setupEnvironment } from "./env";
import cors from "cors";

const env = setupEnvironment();
const GOOGLE_API_KEY = 'AIzaSyDEPEgUlqSxhWtZ30lBoQYKIMX8U0fwZlA';
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);


const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-exp",
  generationConfig: {
    temperature: 0.7,  // Adjust for balanced creativity
    topP: 0.95,        // Allow more diverse results
    topK: 40,          // Broaden search scope
    maxOutputTokens: 4096, // Increase token limit
  },
});

// Store chat sessions in memory
const chatSessions = new Map<string, ChatSession>();

// Format raw text into markdown
async function formatResponseToMarkdown(
  text: string | Promise<string>
): Promise<string> {
  const resolvedText = await Promise.resolve(text);
  let processedText = resolvedText.replace(/\r\n/g, "\n");
  processedText = processedText.replace(/^([A-Za-z][A-Za-z\s]+):(\s*)/gm, "## $1$2");
  processedText = processedText.replace(/(?<=\n|^)([A-Za-z][A-Za-z\s]+):(?!\d)/gm, "### $1");
  processedText = processedText.replace(/^[•●○]\s*/gm, "* ");
  const paragraphs = processedText.split("\n\n").filter(Boolean);
  const formatted = paragraphs
    .map((p) => p.startsWith("#") || p.startsWith("*") || p.startsWith("-") ? p : `${p}\n`)
    .join("\n\n");

  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  return marked.parse(formatted);
}

export function registerRoutes(app: Express): Server {

  // Search endpoint - creates a new chat session
  app.get("/api/search", async (req, res) => {
    try {
      const query = decodeURIComponent(req.query.q as string);
      if (!query) {
        return res.status(400).json({
          message: "Query parameter 'q' is required",
        });
      }

      const chat = model.startChat({
        tools: [
          {
            // @ts-ignore - google_search tool supported but not typed
            google_search: {},
          },
        ],
      });

      const result = await chat.sendMessage(query);
      if (!result || !result.response) {
        return res.status(500).json({
          message: "No response from the generative AI model",
        });
      }
      const response = await result.response;
      const rawText = response.text();
      if (!rawText) {
        throw new Error("No response text received from AI.");
      }

      // Format the response into markdown
      const formattedText = await formatResponseToMarkdown(rawText);

      // Extract sources
      const sourceMap = new Map<string, { title: string; url: string; snippet: string }>();
      const metadata = response.candidates?.[0]?.groundingMetadata as any;
      if (metadata) {
        const chunks = metadata.groundingChunks || [];
        const supports = metadata.groundingSupports || [];

        chunks.forEach((chunk: any, index: number) => {
          if (chunk.web?.uri && chunk.web?.title) {
            const url = chunk.web.uri;
            if (!sourceMap.has(url)) {
              const snippets = supports
                .filter((support: any) => support.groundingChunkIndices.includes(index))
                .map((support: any) => support.segment.text)
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

      // Generate session ID
      const sessionId = Math.random().toString(36).substring(7);
      chatSessions.set(sessionId, chat);

      res.json({
        sessionId,
        summary: formattedText,
        sources,
      });
    } catch (error: any) {
      console.error("Search error:", error);
      res.status(500).json({
        message: error.message || "An error occurred while processing your search",
        details: error.stack || "No stack trace available",
      });
    }
  });

  // Follow-up endpoint - continues existing chat session
  app.post("/api/follow-up", async (req, res) => {
    try {
      const { sessionId, query } = req.body;
      if (!sessionId || !query) {
        return res.status(400).json({
          message: "Both sessionId and query are required",
        });
      }

      const chat = chatSessions.get(sessionId);
      if (!chat) {
        return res.status(404).json({
          message: "Chat session not found",
        });
      }

      const result = await chat.sendMessage(query);
      const response = await result.response;
      const text = response.text();
      const formattedText = await formatResponseToMarkdown(text);

      const sourceMap = new Map<string, { title: string; url: string; snippet: string }>();
      const metadata = response.candidates?.[0]?.groundingMetadata as any;
      if (metadata) {
        const chunks = metadata.groundingChunks || [];
        const supports = metadata.groundingSupports || [];

        chunks.forEach((chunk: any, index: number) => {
          if (chunk.web?.uri && chunk.web?.title) {
            const url = chunk.web.uri;
            if (!sourceMap.has(url)) {
              const snippets = supports
                .filter((support: any) => support.groundingChunkIndices.includes(index))
                .map((support: any) => support.segment.text)
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
      res.status(500).json({
        message:
          error.message ||
          "An error occurred while processing your follow-up question",
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
