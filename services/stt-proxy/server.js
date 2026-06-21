import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TranscriptAggregator } from "../transcript-aggregator/Aggregator.js";
import { EventDetector } from "../event-detector/detector.js";

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
if (!process.env.GROQ_API_KEY) {
  console.warn("WARNING: GROQ_API_KEY is not defined. AI suggestions will fail.");
}

// Playbook configurations for dynamic prompt generation
const PLAYBOOKS = {
  general: {
    name: "General Sales Coach",
    guidelines: "You use a hybrid framework of PAS (Problem, Agitation, Solution) and EVC (Empathy, Value, Close)."
  },
  saas: {
    name: "B2B SaaS & Tech",
    guidelines: `Focus on B2B SaaS objections (integration issues, data security/privacy, implementation timeline, ROI proof, stakeholder alignment). 
Use techniques like Value Selling, objection loops (Acknowledge, Clarify, Validate, Pivot). 
Focus on explaining ease of deployment, security standards (SOC2, GDPR), integration flexibility, and long-term cost efficiencies.`
  },
  insurance: {
    name: "B2C Insurance Sales",
    guidelines: `Focus on B2C insurance objections (premium rates, switching friction, loyalty to current carriers, trust).
Use techniques like highlighting the cost of being underinsured, bundling discounts (auto + home + life), and effortless switching assistance.
Acknowledge rate concerns and redirect to custom coverage, deductibles adjustment, and long-term stability.`
  },
  realestate: {
    name: "Real Estate & Property",
    guidelines: `Focus on real estate objections (market volatility, interest rate anxiety, neighborhood fit, inspection findings, long-term appreciation).
Highlight the value of building equity, localized neighborhood growth trends, and strategies like 'marry the house, refinance the rate'.`
  },
  newtonschool: {
    name: "Newton School Bangalore Admission Coach",
    guidelines: `You are the admission coach for Newton School Bangalore. Assist the Rep in responding to candidate objections using the official training doc.
    
FACTUAL SALES MANUAL CUES:
- Base Pitch: Placement-oriented DS and AI program with lifetime placement support. Excel, SQL, Python, ML. Potential salary: 25 LPA+. MNCs: Amazon, Flipkart, Meesho, IBM. Doubt support: 1:1 sessions with subject experts. Referral pool after 4 months (grooming, resume optimization). Unlimited referrals. MWF 9 pm - 11 pm live classes.
- Fees & Financing: Course price 2.25L. NSDC Interview + Test scholarship brings price down to 1.85L. EMI options up to 36 months starting at 6500/month. No payment in month 1 (e.g. start January, pay February). 
- Placement Objections: NS provides mentorship + grooming. Student must commit 3-4 hours/day. If someone claims lifetime support is a scam, cite Subhadip Das (got 1st and 2nd jobs via Newton School).
- Competitor Objections (Simplilearn/Intellipaat/Cheaper 60k course): Highlight instructor quality (Google/Amazon experts), lifetime placement support (Subhadip Das case), and company-specific grooming sessions before interview rounds. If competitor is expensive, compare USPs directly to show value. If competitor is aligned, connect with similar alum for trust.
- Next Steps Closes: Free 45-min aptitude test (logical, English, no prep) to determine scholarship; or career counseling session (no purchase commitment).
- Govt Job Prep: Govt job prep has cv gap risks and limited options if it fails. Switch to corporate data side now. Compare LPA/CTC trajectories.

STRICT GENERATION RULE:
Do not write long text blocks. Output concise pointers, exact numbers (e.g., 1.85L, 6500/mo, 25 LPA), and concrete student stories. Reps need facts and triggers to construct their own answers, not scripts.`
  }
};

const REFLEX_SUGGESTIONS = {
  COMPETITOR: {
    hubspot: '• Pitch HubSpot battlecard pointers (Soft: "HubSpot is very user-friendly, but custom object limits can block sales scaling." | Bold: "HubSpot limits API calls and custom objects in their standard plans. Let\'s verify your technical requirements.")',
    salesforce: '• Handle Salesforce comparison (Soft: "Salesforce is extremely powerful, but it often requires a dedicated admin to manage." | Bold: "Salesforce implementation will take 6 months and cost double. We can go live in under 2 weeks.")',
    zoho: '• Address Zoho fit (Soft: "Zoho is highly custom, but has complex setup friction." | Bold: "Let\'s compare Zoho\'s custom capability against our out-of-the-box speed.")'
  },
  OBJ_BUDGET: {
    general: '• Handle price objections via ROI (Soft: "I hear you on budget. Let\'s outline the ROI to see if it covers the platform cost." | Bold: "If cost wasn\'t a blocker, would you sign today? Let\'s qualify the priority first.")',
    realestate: '• Address interest rate anxiety (Soft: "I understand rates are higher right now, but you can always refinance when they drop." | Bold: "Marry the house and refinance the rate later. Let\'s secure the property price today.")'
  },
  OBJ_TIMELINE: '• Guarantee rapid onboarding (Soft: "We handle all migration and onboarding in less than 2 weeks." | Bold: "Let\'s commit to a 2-week launch timeline so your reps start seeing value this quarter.")',
  SIGNAL_BUY: '• Lock in next steps and trial (Soft: "Would you like me to share our security SOC2 compliance package?" | Bold: "Let\'s book a 15-minute setup call next Tuesday to configure your workspace sandbox.")'
};

function getReflexSuggestion(intents, playbook) {
  const suggestions = [];
  
  for (const intent of intents) {
    if (intent.cat === "COMPETITOR" && intent.entity) {
      const comp = intent.entity.toLowerCase();
      if (comp.includes("hubspot")) {
        suggestions.push(REFLEX_SUGGESTIONS.COMPETITOR.hubspot);
      } else if (comp.includes("salesforce")) {
        suggestions.push(REFLEX_SUGGESTIONS.COMPETITOR.salesforce);
      } else if (comp.includes("zoho")) {
        suggestions.push(REFLEX_SUGGESTIONS.COMPETITOR.zoho);
      }
    } else if (intent.cat === "OBJ_BUDGET") {
      const option = REFLEX_SUGGESTIONS.OBJ_BUDGET[playbook] || REFLEX_SUGGESTIONS.OBJ_BUDGET.general;
      suggestions.push(option);
    } else if (intent.cat === "OBJ_TIMELINE") {
      suggestions.push(REFLEX_SUGGESTIONS.OBJ_TIMELINE);
    } else if (intent.cat === "SIGNAL_BUY") {
      suggestions.push(REFLEX_SUGGESTIONS.SIGNAL_BUY);
    }
  }
  
  if (suggestions.length === 0) return null;
  return suggestions.join("\nTHEN\n");
}

wss.on("connection", async (ws, req) => {
  console.log("New client connected to proxy server.");

  // Session State
  let conversationHistory = []; // Array of { role: "Rep" | "Customer", text: string }
  let repSpeakerId = null; // We don't know who the rep is until frontend tells us

  // No cooldown active (using paid key)

  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const model = url.searchParams.get("model") || "nova-3";
  const language = url.searchParams.get("language") || "en-US";
  const smartFormat = url.searchParams.get("smart_format") !== "false"; 
  const interimResults = url.searchParams.get("interim_results") !== "false"; 
  const diarize = url.searchParams.get("diarize") !== "false"; // Default true for prototype
  const multichannel = url.searchParams.get("multichannel") === "true";
  const channels = parseInt(url.searchParams.get("channels") || "1", 10);
  const playbook = url.searchParams.get("playbook") || "saas";

  // Build the dynamic prompt based on the chosen playbook
  const chosenPlaybook = PLAYBOOKS[playbook] || PLAYBOOKS.general;
  const salesCoachSystemPrompt = `You are an elite AI Sales Copilot listening to a live sales call, configured for the playbook: "${chosenPlaybook.name}".
${chosenPlaybook.guidelines}

YOUR STRICT OUTPUT RULES:
1. Output a maximum of 2 to 3 bullet points. Each bullet point must represent one clear tactical cue or answer helper.
2. For each bullet point, provide a short tactical direction cue AND a single suggested response phrase in parentheses using the format: (Say: "your suggested response phrase"). Do NOT include "Soft" or "Bold" variations.
3. Keep the direction cue and the suggested phrasing extremely concise. Do not include any other explanations or markdown headers.
4. If the customer is making small talk, confirming details (like the school name "Newton School of Technology" or basic greetings), or if no active sales objection handling is needed, do NOT output any bullet points. Instead, output ONLY the exact text: "Great job, keep going!". Do not include any formatting.

EXAMPLE GOOD OUTPUT:
• Emphasize UGC degree recognition (Say: "Our B.Tech in CS & AI is fully UGC-accredited through our partnership with Rishihood University.")
• Explain 36-month EMI options (Say: "We have flexible financing plans starting at just 6,500 rupees per month across 36 months.")
`;

  // Create Deepgram client
  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  let dgConnection;

  // Initialize Transcript Aggregator
  const aggregator = new TranscriptAggregator({ watchdogTimeout: 2000 });
  
  aggregator.on('utterance', async (utt) => {
    // Append to conversation history (just store speaker ID, we will map roles dynamically)
    conversationHistory.push({ speaker: utt.speaker, text: utt.text });
    
    // Keep sliding window of last 10 utterances
    if (conversationHistory.length > 10) {
      conversationHistory.shift();
    }

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "finalized_utterance", data: utt }));
    }

    // Determine current role to see if we should trigger AI
    let currentRole = "Unknown";
    if (repSpeakerId !== null) {
      currentRole = String(utt.speaker) === String(repSpeakerId) ? "Rep" : "Customer";
    } else {
      currentRole = String(utt.speaker) === "0" ? "Rep" : "Customer";
    }

    console.log(`[Role Mapping] Speaker ${utt.speaker} classified as ${currentRole} (Rep ID: ${repSpeakerId ?? 0})`);

    // Run EventDetector for both Customer and Rep utterances
    const groqApiKey = process.env.GROQ_API_KEY;

    if (groqApiKey && groqApiKey !== "placeholder") {
      try {
        // Run EventDetector
        const detector = new EventDetector({
          playbook: playbook,
          groqApiKey
          // Preserved options for friend's local test config:
          // ollamaUrl: 'http://localhost:11434',
          // modelName: 'gemma4:e4b' // 'llama3.1:8b'
        });

        console.log(`[EventDetector] Running on ${currentRole} utterance: "${utt.text}"`);
        const detectResult = await detector.detect(utt, conversationHistory, currentRole === "Customer");
        console.log(`[EventDetector] Detected Intents:`, JSON.stringify(detectResult.intents));

        // 1. GATEKEEPER / NONE CHECK: Early exit on NONE / no active intents
        if (detectResult.intents.length === 0) {
          // If it was the Rep speaking, we do absolutely nothing (no screen clear)
          if (currentRole === "Rep") {
            return;
          }

          // If Customer said a filler/agreement word, do NOT clear active screen cards
          if (detectResult.source === 'gatekeeper') {
            console.log(`[EventDetector] Customer filler word detected. Keeping current cards on screen.`);
            return;
          }

          // If Customer said a full neutral statement, clear the screen
          console.log(`[EventDetector] Customer neutral statement detected. Sending keep-going signal.`);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ 
              type: "ai_suggestion", 
              data: { text: "Great job, keep going!", timestamp: Date.now() } 
            }));
          }
          return;
        }

        // 2. COGNITIVE ROUTER: Intent-focused suggestion generation
        // Format the history dynamically so retrospective role changes apply to the whole context
        const formattedHistory = conversationHistory.map(h => {
          const isRepSpeaker = repSpeakerId !== null 
            ? String(h.speaker) === String(repSpeakerId) 
            : String(h.speaker) === "0";
          return `[${isRepSpeaker ? 'Rep' : 'Customer'}]: ${h.text}`;
        }).join("\n");
        
        const activeIntentCategories = detectResult.intents.map(i => `${i.cat}${i.entity ? ` (${i.entity})` : ''}`).join(", ");
        
        // Tailor fullPrompt instructions depending on speaker role
        const roleInstruction = currentRole === "Rep"
          ? `The Rep has proactively brought up the topic: ${activeIntentCategories}. Based on the playbook guidelines, generate the relevant details/cues for the Rep to display on their screen.`
          : `Based on the Customer's latest response and active intents, what is your tactical advice for the Rep?`;

        const fullPrompt = `${salesCoachSystemPrompt}
        
=== RECENT CONVERSATION ===
${formattedHistory}

[ACTIVE CONVERSATION TOPIC/INTENT]: ${activeIntentCategories}
${roleInstruction}`;

        let advice = "";

        try {
          console.log(`[AI Triggered] Sending context to Groq (Llama-3.3-70b-specdec)...`);
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${groqApiKey}`
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-specdec",
              messages: [
                { role: "user", content: fullPrompt }
              ],
              temperature: 0.1
            })
          });

          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Groq API Error (${response.status}): ${errText}`);
          }

          const data = await response.json();
          advice = data.choices[0].message.content.trim();
          console.log(`[AI Response] Successfully generated suggestions using Groq Llama 3.3 70B.`);
        } catch (groqErr) {
          console.error(`[AI Triggered] Groq call failed:`, groqErr.message);
        }

        console.log(`[AI Response]:\n${advice}`);
        
        if (advice && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ 
            type: "ai_suggestion", 
            data: { text: advice, timestamp: Date.now() } 
          }));
        }
      } catch (err) {
        console.error("Pipeline Error:", err);
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
      diarize: !multichannel, // Disable AI diarization if hardware multichannel is active
      multichannel: multichannel,
      channels: channels,
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
