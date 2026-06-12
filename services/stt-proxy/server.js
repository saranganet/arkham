import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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

// Check if Deepgram API Key is set
if (!process.env.DEEPGRAM_API_KEY) {
  console.warn("WARNING: DEEPGRAM_API_KEY is not defined in the environment or .env file.");
}

wss.on("connection", async (ws, req) => {
  console.log("New client connected to proxy server.");

  // Check if key is available
  if (!process.env.DEEPGRAM_API_KEY) {
    ws.send(JSON.stringify({
      type: "error",
      message: "DEEPGRAM_API_KEY is not configured on the server. Please add your key to a .env file and restart the server."
    }));
    ws.close(1008, "DEEPGRAM_API_KEY missing");
    return;
  }

  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const model = url.searchParams.get("model") || "nova-3";
  const language = url.searchParams.get("language") || "en-US";
  const smartFormat = url.searchParams.get("smart_format") !== "false"; // default true
  const interimResults = url.searchParams.get("interim_results") !== "false"; // default true
  const diarize = url.searchParams.get("diarize") === "true";

  console.log(`Connecting to Deepgram with settings: Model=${model}, Language=${language}, SmartFormat=${smartFormat}, InterimResults=${interimResults}, Diarize=${diarize}`);

  // Create Deepgram client
  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  let dgConnection;

  try {
    const connectOptions = {
      model,
      language,
      smart_format: smartFormat,
      interim_results: interimResults,
    };

    if (diarize) {
      connectOptions.queryParams = {
        diarize_model: "latest",
      };
    }

    // Connect to live transcription endpoint
    dgConnection = await deepgram.listen.v1.connect(connectOptions);

    // Initiate the WebSocket connection
    dgConnection.connect();

    // Wait for the connection to be fully open before proceeding
    await dgConnection.waitForOpen();
    console.log("Connected to Deepgram API.");

    // Inform browser client we are connected to Deepgram
    ws.send(JSON.stringify({
      type: "status",
      status: "connected",
      message: `Connected to Deepgram (${model})`
    }));

  } catch (err) {
    console.error("Failed to establish Deepgram connection:", err);
    ws.send(JSON.stringify({
      type: "error",
      message: "Deepgram Connection Failed: " + err.message
    }));
    ws.close();
    return;
  }

  // Forward transcripts from Deepgram to the browser client
  dgConnection.on("message", (message) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "transcript",
        data: message
      }));
    }
  });

  // Handle Deepgram closure
  dgConnection.on("close", (event) => {
    console.log("Deepgram connection closed:", event);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "status",
        status: "disconnected",
        message: "Deepgram API disconnected"
      }));
      ws.close();
    }
  });

  // Handle Deepgram error
  dgConnection.on("error", (err) => {
    console.error("Deepgram connection error:", err);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "error",
        message: "Deepgram Error: " + err.message
      }));
    }
  });

  // Handle incoming data from the client browser
  ws.on("message", (message, isBinary) => {
    if (isBinary) {
      // Binary data: audio chunks from browser MediaRecorder
      if (dgConnection && dgConnection.readyState === 1) { // 1 = OPEN
        try {
          dgConnection.sendMedia(message);
        } catch (e) {
          console.error("Error sending media to Deepgram:", e.message);
        }
      }
    } else {
      // Text data: commands or keepalive pings
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (payload.type === "keepalive") {
          // Send keepalive to Deepgram if connection is open
          if (dgConnection && dgConnection.readyState === 1) {
            dgConnection.sendKeepAlive({ type: "KeepAlive" });
          }
        }
      } catch (e) {
        console.error("Error parsing string message from client:", e.message);
      }
    }
  });

  // Cleanup on client disconnect
  ws.on("close", () => {
    console.log("Client browser disconnected.");
    if (dgConnection) {
      try {
        dgConnection.close();
      } catch (e) {
        console.error("Error closing Deepgram connection on disconnect:", e.message);
      }
    }
  });

  ws.on("error", (err) => {
    console.error("Client WS connection error:", err);
    if (dgConnection) {
      try {
        dgConnection.close();
      } catch (e) {
        // ignore
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
