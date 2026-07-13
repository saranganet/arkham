import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { DeepgramClient } from "@deepgram/sdk";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { TranscriptAggregator } from "../transcript-aggregator/Aggregator.js";
import { EventDetector, CATEGORY_MAP, CORE_SALES_KEYWORDS } from "../event-detector/detector.js";
import { pipeline } from "@xenova/transformers";
import { queryRAG, calculateRelevance } from "./rag.js";

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

import fs from "fs";

// Playbook, Category, and Keyword Bypass configurations loaded dynamically from shared configuration folder
const PLAYBOOKS = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../event-detector/config/playbooks.json"), "utf8"));
const categoriesConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../event-detector/config/categories.json"), "utf8"));
const keywordBypasses = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../event-detector/config/keyword_bypasses.json"), "utf8"));

// Category behavior configuration helpers
const getCategoryBehavior = (catKey, playbookId) => {
  const config = categoriesConfig[catKey];
  if (!config) return "ai";
  if (config.behavior && typeof config.behavior === "object") {
    return config.behavior[playbookId] || config.behavior.default || "ai";
  }
  return config.behavior || "ai";
};

const getCategoryGuidelineText = (catKey, playbookId) => {
  const config = categoriesConfig[catKey];
  if (!config) return null;
  if (config.guidelineText && typeof config.guidelineText === "object") {
    return config.guidelineText[playbookId] || config.guidelineText.default || null;
  }
  return config.guidelineText || null;
};



async function fetchTavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || apiKey === "placeholder") {
    console.warn("[Tavily] TAVILY_API_KEY is not set or placeholder. Skipping web search.");
    return null;
  }

  try {
    console.log(`[Tavily] Executing search query: "${query}"...`);
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: 'basic',
        max_results: 2
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`[Tavily] API returned status ${response.status}: ${errText}`);
      return null;
    }

    const data = await response.json();
    if (data && Array.isArray(data.results)) {
      return data.results;
    }
  } catch (err) {
    console.error(`[Tavily] Request failed:`, err.message);
  }
  return null;
}



const REFLEX_SUGGESTIONS = {
  COMPETITOR: {
    hubspot: '• Pitch HubSpot battlecard pointers (Soft: "HubSpot is very user-friendly, but custom object limits can block sales scaling." | Bold: "HubSpot limits API calls and custom objects in their standard plans. Let\'s verify your technical requirements.")',
    salesforce: '• Handle Salesforce comparison (Soft: "Salesforce is extremely powerful, but it often requires a dedicated admin to manage." | Bold: "Salesforce implementation will take 6 months and cost double. We can go live in under 2 weeks.")',
    zoho: '• Address Zoho fit (Soft: "Zoho is highly custom, but has complex setup friction." | Bold: "Let\'s compare Zoho\'s custom capability against our out-of-the-box speed.")'
  },
  BUDGET: {
    general: '• Handle price objections via ROI (Soft: "I hear you on budget. Let\'s outline the ROI to see if it covers the platform cost." | Bold: "If cost wasn\'t a blocker, would you sign today? Let\'s qualify the priority first.")',
    realestate: '• Address interest rate anxiety (Soft: "I understand rates are higher right now, but you can always refinance when they drop." | Bold: "Marry the house and refinance the rate later. Let\'s secure the property price today.")'
  },
  TIMELINE: '• Guarantee rapid onboarding (Soft: "We handle all migration and onboarding in less than 2 weeks." | Bold: "Let\'s commit to a 2-week launch timeline so your reps start seeing value this quarter.")',
  BUY_SIGNAL: '• Lock in next steps and trial (Soft: "Would you like me to share our security SOC2 compliance package?" | Bold: "Let\'s book a 15-minute setup call next Tuesday to configure your workspace sandbox.")'
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
    } else if (intent.cat === "BUDGET") {
      const option = REFLEX_SUGGESTIONS.BUDGET[playbook] || REFLEX_SUGGESTIONS.BUDGET.general;
      suggestions.push(option);
    } else if (intent.cat === "TIMELINE") {
      suggestions.push(REFLEX_SUGGESTIONS.TIMELINE);
    } else if (intent.cat === "BUY_SIGNAL") {
      suggestions.push(REFLEX_SUGGESTIONS.BUY_SIGNAL);
    }
  }

  if (suggestions.length === 0) return null;
  return suggestions.join("\nTHEN\n");
}

// Pre-load local Speech Emotion Recognition model
console.log("Loading local Speech Emotion Recognition model (onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX)...");
const audioClassifier = await pipeline("audio-classification", "onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX", {
  quantized: true,
  cache_dir: "./.cache"
});
console.log("✓ Speech Emotion Recognition model pre-loaded successfully!");

function getAudioSlice(samples, startTime, endTime) {
  const startIdx = Math.floor(startTime * 16000);
  const endIdx = Math.floor(endTime * 16000);
  const clampedStart = Math.max(0, Math.min(startIdx, samples.length - 1));
  const clampedEnd = Math.max(clampedStart, Math.min(endIdx, samples.length));
  return samples.slice(clampedStart, clampedEnd);
}

function mapEmotionLabel(rawLabel) {
  const upper = rawLabel.toUpperCase();
  switch (upper) {
    case "NEUTRAL":
      return "Calm";
    case "HAPPY":
      return "Happy";
    case "ANGRY":
      return "Agitated";
    case "SAD":
      return "Sad";
    case "FEAR":
      return "Anxious";
    case "DISGUST":
      return "Irritated";
    default:
      return upper.charAt(0) + upper.slice(1).toLowerCase();
  }
}

wss.on("connection", async (ws, req) => {
  console.log("New client connected to proxy server.");

  // Session State
  let conversationHistory = []; // Array of { role: "Rep" | "Customer", text: string }
  let repSpeakerId = null; // We don't know who the rep is until frontend tells us

  // Raw Audio samples buffers for speech emotion recognition
  let repAudioSamples = [];
  let customerAudioSamples = [];

  // No cooldown active (using paid key)

  // Parse query parameters
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const model = url.searchParams.get("model") || "nova-3";
  const language = url.searchParams.get("language") || "en-US";
  const smartFormat = url.searchParams.get("smart_format") !== "false";
  const interimResults = url.searchParams.get("interim_results") !== "false";
  const playbook = url.searchParams.get("playbook") || "saas";

  // Build the dynamic prompt based on the chosen playbook
  const chosenPlaybook = PLAYBOOKS[playbook] || PLAYBOOKS.general;

  // Create Deepgram client
  const deepgram = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY });
  let dgConnection;

  // Initialize Transcript Aggregator
  const aggregator = new TranscriptAggregator({ watchdogTimeout: 2000 });

  aggregator.on('utterance', async (utt) => {
    // Determine speaker role and corresponding audio array
    const isRep = String(utt.speaker) === "0" || (repSpeakerId !== null && String(utt.speaker) === String(repSpeakerId));
    const audioSamples = isRep ? repAudioSamples : customerAudioSamples;

    if (audioSamples && audioSamples.length > 0) {
      const slice = getAudioSlice(audioSamples, utt.start, utt.end);
      if (slice.length > 8000) { // at least 0.5s of audio
        try {
          const result = await audioClassifier(slice, { sampling_rate: 16000 });
          if (result && result.length > 0) {
            const topEmotion = result[0];
            utt.emotion = mapEmotionLabel(topEmotion.label);
            utt.emotionScore = topEmotion.score;
            console.log(`[SER] Speaker ${utt.speaker} (${isRep ? 'Rep' : 'Customer'}): ${utt.emotion} (${(topEmotion.score * 100).toFixed(0)}%)`);
          }
        } catch (serErr) {
          console.error(`[SER] Error during classification:`, serErr.message);
        }
      }
    }

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

    let matchedKeywordGuidelines = [];

    // 0. UNIFIED KEYWORD SCANNER (Case-Insensitive Bypass Zero-Shot NLI & Guideline Accumulator)
    const playbookBypasses = keywordBypasses[playbook] || [];
    const lowerText = utt.text.toLowerCase();

    const matchedBypassKeywords = new Set();

    for (const b of playbookBypasses) {
      const kws = b.keywords || [b.keyword];
      const matchingKeywords = kws.filter(kw => lowerText.includes(kw.toLowerCase()));
      if (matchingKeywords.length > 0) {
        for (const kw of matchingKeywords) {
          matchedBypassKeywords.add(kw.toLowerCase());
        }
        if (b.behavior === "guideline" && b.guidelineText) {
          matchedKeywordGuidelines.push(b.guidelineText);
        }
      }
    }

    // Active core safeguards (excluding dynamically overridden keywords)
    const activeCoreKeywords = CORE_SALES_KEYWORDS.filter(kw => !matchedBypassKeywords.has(kw.toLowerCase()));
    const matchedCore = activeCoreKeywords.filter(kw => lowerText.includes(kw.toLowerCase()));

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
        const detectResult = await detector.detect(utt, conversationHistory, currentRole === "Customer", repSpeakerId);
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

        const activeIntentCategories = detectResult.intents.map(i => {
          const friendlyName = CATEGORY_MAP[i.cat] || i.cat;
          return `${friendlyName}${i.entity ? ` (${i.entity})` : ''}`;
        }).join(", ");

        // Step A: Check for category guideline overrides or custom guideline injections
        let customGuidelinesText = "";
        const categoryGuidelines = [];

        for (const intent of detectResult.intents) {
          const behavior = getCategoryBehavior(intent.cat, playbook);
          if (behavior === "guideline") {
            const guide = getCategoryGuidelineText(intent.cat, playbook);
            if (guide) {
              categoryGuidelines.push(guide);
            }
          }
        }

        // Combine category guidelines and matched keyword guidelines
        const combinedGuidelines = [
          ...categoryGuidelines,
          ...matchedKeywordGuidelines
        ];

        if (combinedGuidelines.length > 0) {
          customGuidelinesText = "\n" + combinedGuidelines.map(g => `• ${g}`).join("\n");
        }

        let combinedFacts = "";
        
        // Resolve search query (use the LLM 1 generated query or fall back to raw utterance)
        const searchQuery = detectResult.suggested_search_query || utt.text;
        console.log(`[RAG] Querying vector store using: "${searchQuery}"`);
        const ragResults = await queryRAG(searchQuery, playbook, 3);
        let mappedFacts = "";
        if (ragResults && ragResults.length > 0) {
          console.log(`[RAG] Found ${ragResults.length} matching document chunks.`);
          mappedFacts = ragResults.map(r => `• ${r.text}`).join("\n");
        } else {
          console.log(`[RAG] No matching document chunks found in database.`);
        }

        if (customGuidelinesText) {
          mappedFacts += customGuidelinesText;
        }

        // Step B: Query Tavily Web Search if RAG matches + custom guidelines are weak
        let searchSnippet = "";
        const hasConfidentRag = (ragResults && ragResults.length > 0 && ragResults.some(r => r.score >= 0.60)) || !!customGuidelinesText;
        const allowsWebSearch = detectResult.intents.some(intent => categoriesConfig[intent.cat]?.type === "public");
        let needsTavily = allowsWebSearch && !hasConfidentRag;
        let unknownEntity = null;

          for (const intent of detectResult.intents) {
            if (intent.entity) {
              const entityName = intent.entity.toLowerCase();
              const isKnownEntity = entityName.includes("salesforce") ||
                entityName.includes("hubspot") ||
                entityName.includes("zoho") ||
                entityName.includes("masai") ||
                entityName.includes("scaler") ||
                entityName.includes("simplilearn") ||
                entityName.includes("intellipaat") ||
                entityName.includes("rishihood") ||
                entityName.includes("newton school");
              if (!isKnownEntity) {
                needsTavily = true;
                unknownEntity = intent.entity;
                break;
              }
            }
          }

          if (needsTavily) {
            const query = searchQuery;
            console.log(`[RAG] Triggering Tavily Search Fallback with query: "${query}"`);
            const rawSearchResults = await fetchTavilySearch(query);

            if (rawSearchResults && rawSearchResults.length > 0) {
              let alignedSnippets = [];
              for (const result of rawSearchResults) {
                const relevanceScore = await calculateRelevance(result.content, query);
                console.log(`[RAG] Tavily snippet similarity check: score = ${relevanceScore.toFixed(2)} for "${result.content.substring(0, 60)}..."`);
                if (relevanceScore >= 0.35) {
                  alignedSnippets.push(result);
                } else {
                  console.log(`[RAG] Discarding Tavily snippet because score ${relevanceScore.toFixed(2)} is below threshold 0.35`);
                }
              }

              if (alignedSnippets.length > 0) {
                const snippetsText = alignedSnippets.map(r => `Source: ${r.title} (${r.url})\nContent: ${r.content}`).join("\n\n");
                searchSnippet += `\n\n[Real-time Web Search Results]:\n${snippetsText}`;
              } else {
                console.log(`[RAG] All fetched snippets discarded due to low relevance.`);
              }
            }
          }

          combinedFacts = `${mappedFacts}${searchSnippet}`;
          if (!combinedFacts.trim()) {
            combinedFacts = "No specific guidelines or policies found. Provide helpful, polite sales assistance based on general customer objection handling.";
          }
        }

        // Tailor fullPrompt instructions depending on speaker role
        const roleInstruction = currentRole === "Rep"
          ? `The Rep has proactively brought up the topic: ${activeIntentCategories}. Based on the playbook guidelines, generate the relevant details/cues for the Rep to display on their screen.`
          : `Based on the Customer's latest response and active intents, what is your tactical advice for the Rep?`;

        const tailoredPlaybookPrompt = `You are an elite AI Sales Copilot listening to a live sales call, configured for the playbook: "${chosenPlaybook.name}".
        
FACTUAL SALES MANUAL CUES:
${combinedFacts}

YOUR STRICT OUTPUT RULES:
1. Your advice or output must be formatted in the form of bullet points.
2. Keep the advice/cue and its suggested phrasing extremely concise. Do not include any markdown headers.

3. CATEGORY-SPECIFIC RETRIEVAL & GROUNDING RULES:
   - For INTERNAL policy categories (FEES, PLACEMENT, DEGREE, BUY_SIGNAL): 
     You must rely strictly on the provided RAG guidelines under FACTUAL SALES MANUAL CUES. If no relevant local guidelines are provided, do NOT fabricate pricing, eligibility, or policies; instead, output the Defer to follow-up card.
   - For PUBLIC knowledge categories (COMPETITOR, INQUIRY, SWITCHING):
     * If BOTH local RAG guidelines and real-time web search results are provided: You must compare them directly. Contrast the competitor's retrieved details (e.g. competitor fees, reviews, features) or technologies with our specific playbook USPs (e.g. Newton School's fees, mentor quality, placement history) to highlight our advantages.
     * If ONLY web search results are provided (and local RAG cues are empty): Highlight the search facts (e.g. competitor stats, tech specs, salary averages), but do NOT speculate or make up any details about our pricing/features. Present only the searched data and output the Defer to follow-up card for our specific details, or guide the Rep to offer a free Career Counseling Session.
`;

        const fullPrompt = `${tailoredPlaybookPrompt}
        
=== RECENT CONVERSATION ===
${formattedHistory}

[ACTIVE CONVERSATION TOPIC/INTENT]: ${activeIntentCategories}
${roleInstruction}`;

        let advice = "";

        try {
          console.log(`[AI Triggered] Sending context to Groq Llama 3.1 8B (llama-3.1-8b-instant)...`);
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${groqApiKey}`
            },
            body: JSON.stringify({
              model: "llama-3.1-8b-instant",
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
          console.log(`[AI Response] Successfully generated suggestions using Groq Llama 3.1 8B.`);
        } catch (groqErr) {
          console.error(`[AI Triggered] Groq call failed:`, groqErr.message);
        }

        console.log(`[AI Response]:\n${advice}`);

        if (advice && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "ai_suggestion",
            data: {
              text: advice,
              timestamp: Date.now(),
              category: activeIntentCategories
            }
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
      encoding: 'linear16',
      sample_rate: 16000,
      endpointing: 500, // Enable Deepgram VAD (500ms silence threshold)
      diarize: false, // AI diarization completely disabled
      multichannel: true, // Always use multichannel (Channel 0 = Microphone/Rep, Channel 1 = Speaker/Customer)
      channels: 2, // Always transcribe 2 channels (mic and speaker loopback)
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
      // Append interleaved Int16 PCM samples to respective channel Float32 buffers
      try {
        const numSamples = message.length / 4; // stereo 16-bit is 4 bytes per frame
        for (let i = 0; i < numSamples; i++) {
          const leftVal = message.readInt16LE(i * 4);
          const rightVal = message.readInt16LE(i * 4 + 2);

          repAudioSamples.push(leftVal / 32768.0);
          customerAudioSamples.push(rightVal / 32768.0);
        }
      } catch (err) {
        console.error("Error unpacking binary PCM packet:", err.message);
      }

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
      try { dgConnection.close(); } catch (e) { }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
