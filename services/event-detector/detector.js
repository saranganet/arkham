import { EventEmitter } from 'events';
import crypto from 'crypto';
import { pipeline, env } from '@xenova/transformers';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// Set the cache directory inside the local workspace to avoid sandbox file permission issues
env.cacheDir = './.cache';
env.allowLocalModels = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic playbooks and categories loaded from config files
const PLAYBOOKS = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'playbooks.json'), 'utf8'));
const categoriesConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'categories.json'), 'utf8'));

export const CATEGORY_MAP = Object.fromEntries(
  Object.entries(categoriesConfig).map(([key, val]) => [key, val.label])
);

// Common fillers & agreement words for gatekeeper exit
const FILLER_WORDS = new Set([
  'yeah', 'yes', 'ok', 'okay', 'no', 'yep', 'yup', 'nope', 'cool', 'sure', 
  'got it', 'right', 'uh-huh', 'mhm', 'nice', 'fine', 'agree', 'correct',
  'great', 'hello', 'hi', 'thanks', 'thank you', 'ah', 'oh', 'um', 'uh'
]);

export class EventDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.playbook = options.playbook || 'saas';
    this.contextWindowSize = options.contextWindowSize || 5;
    this.groqApiKey = options.groqApiKey || process.env.GROQ_API_KEY;

    // Asynchronously initialize the zero-shot classifier pipeline
    this.zeroShotPipelinePromise = null;
    this.initClassifier().catch(() => {});

    // Preserved config options for local testing (friend's config)
    // this.ollamaUrl = options.ollamaUrl || 'http://localhost:11434';
    // this.modelName = options.modelName || 'gemma4:e4b'; // 'llama3.1:8b';
  }

  async initClassifier() {
    if (!this.zeroShotPipelinePromise) {
      console.log("[EventDetector] Initializing local Zero-Shot Classifier (Xenova/nli-deberta-v3-small)...");
      this.zeroShotPipelinePromise = pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small').catch(err => {
        console.error("[EventDetector] Failed to load local Zero-Shot Classifier:", err.message);
        this.zeroShotPipelinePromise = null;
        throw err;
      });
    }
    return this.zeroShotPipelinePromise;
  }

  hasSalesKeyword(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    const chosenPlaybook = PLAYBOOKS[this.playbook] || PLAYBOOKS.general;
    const keywords = chosenPlaybook.salesKeywords || [];
    return keywords.some(kw => lowerText.includes(kw));
  }

  async isZeroShotSmallTalk(text) {
    try {
      const classifier = await this.initClassifier();
      if (!classifier) return false;

      const candidateLabels = [
        "neutral greeting, brand check, names check, small talk, pleasantry, callback request",
        "sales objection, business question, course details, fees, placements, credentials"
      ];
      
      const result = await classifier(text, candidateLabels);
      const smallTalkIndex = result.labels.indexOf("neutral greeting, brand check, names check, small talk, pleasantry, callback request");
      const score = result.scores[smallTalkIndex];
      
      console.log(`[EventDetector] Zero-Shot check for "${text}": Small Talk Score = ${(score * 100).toFixed(1)}%`);
      return score >= 0.70;
    } catch (e) {
      console.error("[EventDetector] Local Zero-Shot classification error:", e.message);
      return false;
    }
  }

  // Early-exit check for low-value / short utterances (runs in 0ms)
  isFillerUtterance(text) {
    if (!text) return true;
    const cleanText = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
    if (!cleanText) return true;
    
    const words = cleanText.split(/\s+/);
    if (words.length >= 4) return false;

    // Check if all words are filler words
    return words.every(word => FILLER_WORDS.has(word));
  }

  // Early-exit check for basic greetings (0ms)
  isSimpleGreeting(text) {
    if (!text) return false;
    const cleanText = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
    return /^(hello|hi|hey|good morning|good afternoon|good evening|yo|hey there)$/.test(cleanText);
  }

  // Filters out neutral or NONE classifications
  mergeIntents(llmIntents) {
    return llmIntents.filter(item => item.cat !== "NONE");
  }

  // Construct the system prompt for the 8B parameter model
  getSystemPrompt() {
    const chosenPlaybook = PLAYBOOKS[this.playbook] || PLAYBOOKS.general;
    
    // Dynamically build the category schema list
    const schemaLines = Object.entries(categoriesConfig)
      .map(([key, value]) => `- ${key}: ${value.description}`)
      .join('\n');

    return `You are a high-performance sales conversation router. Your task is to analyze the speaker's utterance (Rep or Customer) in a sales call and classify the underlying sales intent, objection, or proactive topic transition.

Configured Playbook: "${chosenPlaybook.name}"
Playbook Focus Guidelines: ${chosenPlaybook.guidelines}

Classification Schema ("cat" code):
${schemaLines}

You MUST respond with a valid JSON object strictly adhering to this compressed format:
{
  "intents": [
    {
      "cat": "CATEGORY_CODE",
      "conf": 0.0-1.0,
      "entity": "EXTRACTED_ENTITY_OR_NULL"
    }
  ],
  "suggested_search_query": "CONCISE_KEYWORDS_FOR_WEB_AND_RAG_SEARCH_OR_NULL"
}

Ensure:
1. Short output generation. Keep intents array to only active categories.
2. Return ONLY JSON. Do not include markdown formatting or explanation outside JSON.
3. For the "entity" field, extract the specific subject name from the text (e.g., if category is COMPETITOR, extract the specific name of the competitor mentioned, even if not listed in the examples. If no specific entity name is mentioned, return null).
4. For the "suggested_search_query" field, if the intents list has valid categories (not NONE), formulate a highly concise search query (3-6 keywords) designed to find the answer to the customer's specific question or objection. Resolve any pronouns (like "it", "they") to their context (e.g. if customer says "is it UGC approved", make query "Newton School B.Tech UGC approval"). If no search is needed or category is NONE, return null.`;
  }

  // Formats conversation history sliding window for context resolution
  formatContext(history, currentUtterance, repSpeakerId = 0) {
    const contextLines = [];
    const window = history.slice(-this.contextWindowSize);
    const repId = repSpeakerId !== null ? String(repSpeakerId) : "0";
    
    for (const turn of window) {
      const label = String(turn.speaker) === repId ? "Rep" : "Customer";
      contextLines.push(`[${label}]: ${turn.text}`);
    }
    
    contextLines.push(`[Customer] (CURRENT): ${currentUtterance.text}`);
    return contextLines.join("\n");
  }

  // Main entrypoint: evaluates utterance, triggers reflex match, then schedules 8B cognitive router
  async detect(utterance, history = [], isCustomer = true, repSpeakerId = 0) {
    const eventId = "det_" + crypto.randomBytes(4).toString('hex');
    const timestamp = Date.now();

    // Build the default blank/none response object
    const makeEvent = (intents) => ({
      id: eventId,
      utteranceId: utterance.id,
      speaker: utterance.speaker,
      role: isCustomer ? "Customer" : "Rep",
      intents,
      timestamp
    });

    // Find the last utterance from the OTHER speaker in history to see if it was a question
    let lastOtherUtterance = null;
    const currentSpeakerStr = String(utterance.speaker);
    for (let i = history.length - 1; i >= 0; i--) {
      if (String(history[i].speaker) !== currentSpeakerStr) {
        lastOtherUtterance = history[i].text;
        break;
      }
    }

    let isRespondingToQuestion = false;
    if (lastOtherUtterance) {
      const cleanOtherText = lastOtherUtterance.trim();
      isRespondingToQuestion = cleanOtherText.endsWith('?') || 
                               /\b(would|should|could|can|do|does|did|is|are|shall|will|how|what|why|where|who)\b.*\b(you|we|i|it|this|that|go|like|want|start|book|take|proceed)\b/i.test(cleanOtherText);
    }

    // 1. GATEKEEPER CHECK: Early exit on filler text (0ms latency), unless responding to a question
    if (this.isFillerUtterance(utterance.text) && !isRespondingToQuestion) {
      console.log(`[EventDetector] Early exit (0ms) on filler text: "${utterance.text}"`);
      const event = { ...makeEvent([]), source: 'gatekeeper' };
      this.emit('event', { ...event, isReflex: true });
      return event;
    }

    // 1.5. SIMPLE GREETING CHECK: Early exit on pure simple greetings (0ms latency)
    if (this.isSimpleGreeting(utterance.text)) {
      console.log(`[EventDetector] Early exit (0ms) on simple greeting: "${utterance.text}"`);
      const event = { ...makeEvent([]), source: 'neutral_filter' };
      this.emit('event', { ...event, isReflex: true });
      return event;
    }

    // 1.7. LOCAL ZERO-SHOT CHECK: Early exit on complex small talk (bypassed ONLY if sales keywords are present in active context)
    const textToClassify = isRespondingToQuestion && lastOtherUtterance
      ? `${lastOtherUtterance} ${utterance.text}`
      : utterance.text;

    if (!this.hasSalesKeyword(textToClassify)) {
      // If they are answering a question with a short filler/agreement word, do NOT run zero-shot
      const isShortFiller = this.isFillerUtterance(utterance.text);
      if (isRespondingToQuestion && isShortFiller) {
        console.log(`[EventDetector] Bypassing zero-shot for direct question response: "${utterance.text}"`);
      } else {
        console.log(`[EventDetector] Running local Zero-Shot Classifier check...`);
        const isSmallTalk = await this.isZeroShotSmallTalk(textToClassify);
        if (isSmallTalk) {
          console.log(`[EventDetector] Early exit (local zero-shot) on small talk: "${utterance.text}"`);
          const event = { ...makeEvent([]), source: 'local_zeroshot' };
          this.emit('event', { ...event, isReflex: true });
          return event;
        }
      }
    }

    // 2. COGNITIVE ROUTER (Groq Llama 3.1 8B)
    let llmIntents = [];
    let suggestedSearchQuery = null;
    const promptContext = this.formatContext(history, utterance, repSpeakerId);

    if (this.groqApiKey && this.groqApiKey !== "placeholder") {
      try {
        console.log(`[EventDetector] Routing classification query to Groq (Llama 3.1 8B)...`);
        const result = await this.queryGroq(promptContext);
        llmIntents = result.intents || [];
        suggestedSearchQuery = result.suggested_search_query || null;
      } catch (err) {
        console.error(`[EventDetector] Groq classification failed:`, err.message);
      }
    } else {
      console.warn(`[EventDetector] Groq API Key is not set or placeholder.`);
    }

    // Filter neutral intents
    const finalizedIntents = this.mergeIntents(llmIntents);
    const finalizedEvent = { 
      ...makeEvent(finalizedIntents), 
      source: 'cognitive', 
      suggested_search_query: suggestedSearchQuery 
    };

    this.emit('event', { ...finalizedEvent, isReflex: false });
    return finalizedEvent;
  }

  // Query Groq Llama-3.1-8b-instant
  async queryGroq(contextText) {
    const systemPrompt = this.getSystemPrompt();

    if (!this.groqApiKey || this.groqApiKey === "placeholder") {
      throw new Error("Groq API key not configured.");
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze context:\n\n${contextText}` }
        ],
        temperature: 0.0,
        max_tokens: 256,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new Error(`Groq API returned status ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    return this.parseJSONIntents(content);
  }

  /* Preserved local Ollama & Gemini fallbacks for reference:
  async queryOllama(contextText) {
    const systemPrompt = this.getSystemPrompt();
    const url = `${this.ollamaUrl}/api/chat`;
    console.log(`[EventDetector] Querying Local Ollama (${this.modelName})...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze context:\n\n${contextText}` }
        ],
        stream: false,
        format: 'json',
        options: { temperature: 0.0, num_predict: 1024 }
      })
    });
    if (!response.ok) throw new Error(`Ollama status ${response.status}`);
    const data = await response.json();
    return this.parseJSONIntents(data.message?.content || "");
  }

  async queryGemini(contextText) {
    const systemPrompt = this.getSystemPrompt();
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\nAnalyze this:\n\n${contextText}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.0, maxOutputTokens: 256, thinkingConfig: { thinkingBudget: 0 } }
      })
    });
    if (!response.ok) throw new Error(`Gemini status ${response.status}`);
    const data = await response.json();
    return this.parseJSONIntents(data.candidates?.[0]?.content?.parts?.[0]?.text || "");
  }
  */

  // Safe parsing helper
  parseJSONIntents(jsonString) {
    try {
      const cleanJson = jsonString.trim();
      const parsed = JSON.parse(cleanJson);
      
      let intents = [];
      let suggested_search_query = null;
      
      if (parsed && Array.isArray(parsed.intents)) {
        intents = parsed.intents.map(item => ({
          cat: String(item.cat || "NONE").toUpperCase(),
          conf: typeof item.conf === 'number' ? item.conf : 0.8,
          entity: item.entity ? String(item.entity) : null
        }));
      }
      
      if (parsed && parsed.suggested_search_query) {
        suggested_search_query = String(parsed.suggested_search_query);
      }
      
      return { intents, suggested_search_query };
    } catch (e) {
      console.error(`[EventDetector] Failed to parse JSON content: "${jsonString}"`, e.message);
    }
    return { intents: [], suggested_search_query: null };
  }
}
