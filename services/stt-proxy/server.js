import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TranscriptAggregator } from "../transcript-aggregator/Aggregator.js";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve public directory
app.use(express.static(path.join(__dirname, "public")));

// Check API Keys
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn("WARNING: DEEPGRAM_API_KEY is not defined.");
}
if (!process.env.GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not defined. AI suggestions will fail.");
}

// Initialize Gemini Client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "placeholder" });

// System Prompt Guidelines for Gemini
const SALES_COACH_SYSTEM_PROMPT = `You are an elite B2C AI Sales Copilot listening to a live sales call.
You use a hybrid framework of PAS (Problem, Agitation, Solution) and EVC (Empathy, Value, Close).

YOUR STRICT OUTPUT RULES:
1. Output a maximum of 5 to 6 bullet points. 
2. Ensure the points are chronological/ordered. Put the word "THEN" on its own separate line between each bullet point to show the flow.
3. Use the absolute minimum amount of English. Give raw, direct, short command cues.
4. NEVER write conversational explanations (e.g. do not write "The customer sounds stressed, you should...").
5. If the customer is making small talk, output exactly: "Great job, keep going!".

EXAMPLE GOOD OUTPUT:
• Show empathy for budget stress
THEN
• agitate the cost of current car repairs
THEN
• pitch insurance savings

EXAMPLE BAD OUTPUT (DO NOT DO THIS):
Stop pitching features. The customer sounds stressed about their family budget. Show empathy first.`;

wss.on("connection", async (ws, req) => {
  console.log("New client connected to proxy server.");

  // Session State
  let conversationHistory = []; // Array of { role: "Rep" | "Customer", text: string }
  let repSpeakerId = null; // We don't know who the rep is until frontend tells us

  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const model = url.searchParams.get("model") || "nova-3";
  const language = url.searchParams.get("language") || "en-US";
  const smartFormat = url.searchParams.get("smart_format") !== "false"; 
  const interimResults = url.searchParams.get("interim_results") !== "false"; 
  const diarize = url.searchParams.get("diarize") !== "false"; // Default true for prototype

  // Create Deepgram client
  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  let dgConnection;

  // Initialize Transcript Aggregator
  const aggregator = new TranscriptAggregator({ watchdogTimeout: 2000 });
  
  aggregator.on('utterance', async (utt) => {
    // Determine the role
    let role = "Unknown";
    if (repSpeakerId !== null) {
      role = utt.speaker === repSpeakerId ? "Rep" : "Customer";
    } else {
      // Fallback: If not set, assume speaker 0 is Rep
      role = utt.speaker === 0 ? "Rep" : "Customer";
    }

    // Append to conversation history
    conversationHistory.push({ role, text: utt.text, speaker: utt.speaker });
    
    // Keep sliding window of last 10 utterances to not blow up context token limits
    if (conversationHistory.length > 10) {
      conversationHistory.shift();
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "finalized_utterance", data: utt }));
    }

    // TRIGGER AI IF IT IS THE CUSTOMER SPEAKING
    if (role === "Customer" && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "placeholder") {
      try {
        // Format the history for the prompt
        const formattedHistory = conversationHistory.map(h => `[${h.role}]: ${h.text}`).join("\n");
        const fullPrompt = `${SALES_COACH_SYSTEM_PROMPT}\n\n=== RECENT CONVERSATION ===\n${formattedHistory}\n\nBased on the Customer's latest response, what is your tactical advice for the Rep?`;

        console.log(`[AI Triggered] Sending context to Gemini 2.5 Flash...`);
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: fullPrompt,
        });

        const advice = response.text.trim();
        
        console.log(`[AI Response]: ${advice}`);
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ 
            type: "ai_suggestion", 
            data: { text: advice, timestamp: Date.now() } 
          }));
        }
      } catch (err) {
        console.error("Gemini API Error:", err);
      }
    }
  });

  try {
    const connectOptions = {
      model,
      language,
      smart_format: smartFormat,
      interim_results: interimResults,
      endpointing: 500, // Enable Deepgram VAD (500ms silence threshold)
      diarize: true,    // Hardcode diarization to true
    };

    // Connect to live transcription endpoint
    dgConnection = await deepgram.listen.v1.connect(connectOptions);
    dgConnection.connect();
    await dgConnection.waitForOpen();
    console.log("Connected to Deepgram API.");

    ws.send(JSON.stringify({
      type: "status",
      status: "connected",
      message: `Connected to Deepgram (${model})`
    }));

  } catch (err) {
    console.error("Failed to establish Deepgram connection:", err);
    ws.send(JSON.stringify({ type: "error", message: "Deepgram Connection Failed: " + err.message }));
    ws.close();
    return;
  }

  // Forward transcripts from Deepgram to the browser client
  dgConnection.on("message", (message) => {
    try {
      aggregator.processChunk(message);
    } catch (e) {
      console.error("Aggregator error:", e);
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "transcript", data: message }));
    }
  });

  dgConnection.on("close", (event) => {
    console.log("Deepgram connection closed:", event);
    aggregator.flush();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "status", status: "disconnected", message: "Deepgram API disconnected" }));
      ws.close();
    }
  });

  dgConnection.on("error", (err) => {
    console.error("Deepgram connection error:", err);
  });

  // Handle incoming data from the client browser
  ws.on("message", (message, isBinary) => {
    if (isBinary) {
      if (dgConnection && dgConnection.readyState === 1) { 
        try {
          dgConnection.sendMedia(message);
        } catch (e) {
          console.error("Error sending media to Deepgram:", e.message);
        }
      }
    } else {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (payload.type === "keepalive") {
          if (dgConnection && dgConnection.readyState === 1) {
            dgConnection.sendKeepAlive({ type: "KeepAlive" });
          }
        } else if (payload.type === "set_rep_speaker") {
          // Identify which speaker is the rep from the UI
          repSpeakerId = payload.speaker_id;
          console.log(`[Session] Speaker ${repSpeakerId} marked as Sales Rep.`);
        }
      } catch (e) {
        console.error("Error parsing string message from client:", e.message);
      }
    }
  });

  // Cleanup on client disconnect
  ws.on("close", () => {
    console.log("Client browser disconnected.");
    aggregator.flush();
    if (dgConnection) {
      try { dgConnection.close(); } catch (e) {}
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
