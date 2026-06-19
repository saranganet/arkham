import { EventEmitter } from 'events';
import crypto from 'crypto';

// Standard playbooks for contextual guidelines
const PLAYBOOKS = {
  general: {
    name: "General Sales Coach",
    guidelines: "Focus on general sales intents, objection identification, and buying signals using standard sales techniques."
  },
  saas: {
    name: "B2B SaaS & Tech",
    guidelines: "Focus on B2B SaaS objections (integration issues, data security/privacy, implementation timeline, ROI proof, stakeholder alignment)."
  },
  insurance: {
    name: "B2C Insurance Sales",
    guidelines: "Focus on B2C insurance objections (premium rates, switching friction, loyalty to current carriers, trust)."
  },
  realestate: {
    name: "Real Estate & Property",
    guidelines: "Focus on real estate objections (market volatility, interest rate anxiety, neighborhood fit, inspection findings, appreciation)."
  },
  newtonschool: {
    name: "Newton School Bangalore Admission Coach",
    guidelines: "Focus on edtech enrollment goals: placements (CTC, packages, partner network), Income Share Agreements (ISA vs upfront fees), Rishihood University degree affiliation, UGC approval, and curriculum comparisons."
  }
};

// Compact categories map for the output schemas
const CATEGORY_MAP = {
  OBJ_BUDGET: "Objection: Budget / Pricing",
  OBJ_TIMELINE: "Objection: Implementation / Onboarding Timeline",
  OBJ_SWITCHING: "Objection: Switching Friction / Contract Lock-in",
  COMPETITOR: "Competitor Mentioned",
  SIGNAL_BUY: "Buying Signal / Next Steps",
  INQUIRY: "Product / General Inquiry",
  NONE: "No Specific Objection / Intent",
  OBJ_ISA_FEES: "Objection: ISA / Course Fees",
  OBJ_PLACEMENT: "Objection: Job Placements / CTC",
  OBJ_AFFILIATION: "Objection: Degree Affiliation / Accreditation"
};

// Common fillers & agreement words for gatekeeper exit
const FILLER_WORDS = new Set([
  'yeah', 'yes', 'ok', 'okay', 'no', 'yep', 'yup', 'nope', 'cool', 'sure', 
  'got it', 'right', 'uh-huh', 'mhm', 'nice', 'fine', 'agree', 'correct',
  'great', 'hello', 'hi', 'thanks', 'thank you', 'ah', 'oh', 'um', 'uh'
]);

export class EventDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ollamaUrl = options.ollamaUrl || 'http://localhost:11434';
    this.modelName = options.modelName || 'llama3.1:8b';
    this.playbook = options.playbook || 'saas';
    this.contextWindowSize = options.contextWindowSize || 5;
    this.fallbackToCloud = options.fallbackToCloud !== false;
    
    this.groqApiKey = options.groqApiKey || process.env.GROQ_API_KEY;
    this.geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY;
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

  // Early-exit check for basic greetings, names, or neutral school identification checks (0ms)
  isNeutralOrGreeting(text) {
    if (!text) return true;
    const lowerText = text.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "");
    if (!lowerText) return true;
    
    const neutralPatterns = [
      /^(hello|hi|hey|good morning|good afternoon|good evening|yo)$/,
      /^is this\s+(newton\s+school|newton|newton\s+school\s+of\s+technology)/,
      /^am i speaking\s+(to|with)\s+(newton\s+school)/,
      /^who\s+is\s+this/,
      /^can you hear me/,
      /^is anyone there/,
      /^yes\s+is\s+this\s+(newton\s+school|newton|newton\s+school\s+of\s+technology)/
    ];

    if (neutralPatterns.some(pattern => pattern.test(lowerText))) {
      return true;
    }
    
    if (lowerText.includes("newton school") && (lowerText.startsWith("hello") || lowerText.startsWith("hi") || lowerText.includes("is this") || lowerText.includes("am i speaking"))) {
      // Check if it has any objection keywords. If not, it is neutral.
      const hasObjectionKeyword = lowerText.match(/(fee|fees|pricing|cost|payment|isa|income share|installment|emi|loan|scholarship|refund|placement|package|job|hire|hiring|salary|lpa|ctc|placement cells|career|pharmacy|govt|ugc|affiliation|degree|university|recognition|accredited|rishihood)/i);
      if (!hasObjectionKeyword) {
        return true;
      }
    }

    return false;
  }

  // Fast-path Regex matching (runs in <5ms)
  runRegexRules(text) {
    const intents = [];
    const lowerText = text.toLowerCase();

    if (this.playbook === 'newtonschool') {
      // 1. Competitor Detection (Newton School context)
      const competitorMatch = text.match(/(masai|scaler|coding ninjas|upgrad|great learning|simplilearn)/i);
      if (competitorMatch) {
        intents.push({
          cat: "COMPETITOR",
          conf: 1.0,
          entity: competitorMatch[0]
        });
      }

      // 2. Fees & ISA Objection
      if (lowerText.match(/(fee|fees|pricing|cost|payment|isa|income share|installment|emi|loan|scholarship|refund)/i)) {
        intents.push({
          cat: "OBJ_ISA_FEES",
          conf: 0.95,
          entity: null
        });
      }

      // 3. Placement Objection
      if (lowerText.match(/(placement|package|job|hire|hiring|salary|lpa|ctc|placement cells|career|pharmacy|govt)/i)) {
        intents.push({
          cat: "OBJ_PLACEMENT",
          conf: 0.95,
          entity: null
        });
      }

      // 4. Affiliation Objection
      if (lowerText.match(/(ugc|affiliation|degree|university|recognition|accredited|rishihood)/i)) {
        intents.push({
          cat: "OBJ_AFFILIATION",
          conf: 0.95,
          entity: null
        });
      }
    } else {
      // Standard SaaS Playbook Regex
      // 1. Competitor Detection
      const competitorMatch = text.match(/(salesforce|hubspot|zoho|freshsales|exotel|cluel(y|ie))/i);
      if (competitorMatch) {
        intents.push({
          cat: "COMPETITOR",
          conf: 1.0,
          entity: competitorMatch[0]
        });
      }

      // 2. Budget Objection Detection
      if (lowerText.match(/(price|pricing|cost|expensive|cheap|charge|budget|billing|premium|discount|dollar|money|pay)/i)) {
        intents.push({
          cat: "OBJ_BUDGET",
          conf: 0.9,
          entity: null
        });
      }

      // 3. Timeline Objection Detection
      if (lowerText.match(/(timeline|onboard|deploy|implement|schedule|deadline|how long|weeks|months)/i)) {
        intents.push({
          cat: "OBJ_TIMELINE",
          conf: 0.9,
          entity: null
        });
      }

      // 4. Buying Signal Detection
      if (lowerText.match(/(sign|contract|buy|purchase|procure|compliant|compliance|security|soc2|demo|trial)/i)) {
        intents.push({
          cat: "SIGNAL_BUY",
          conf: 0.85,
          entity: null
        });
      }
    }

    return intents;
  }

  // Merges and deduplicates rules-based and cognitive model-based intents
  mergeIntents(regexIntents, llmIntents) {
    const merged = new Map();

    // Load regex intents (they are rule-based so high confidence/high priority)
    for (const item of regexIntents) {
      merged.set(item.cat, item);
    }

    // Override or add LLM intents (except if regex is already 1.0 confidence)
    for (const item of llmIntents) {
      if (item.cat === "NONE") continue;
      
      const existing = merged.get(item.cat);
      if (!existing || (existing.conf < 1.0 && item.conf > existing.conf)) {
        merged.set(item.cat, item);
      }
    }

    return Array.from(merged.values());
  }

  // Construct the system prompt for the 8B parameter model
  getSystemPrompt() {
    const chosenPlaybook = PLAYBOOKS[this.playbook] || PLAYBOOKS.general;
    return `You are a high-performance sales conversation router. Your task is to analyze the customer's utterance in a sales call and classify the underlying sales intent or objection.

Configured Playbook: "${chosenPlaybook.name}"
Playbook Focus Guidelines: ${chosenPlaybook.guidelines}

Classification Schema ("cat" code):
- OBJ_BUDGET: Concerns about cost, price, expensive subscriptions, discount requests (SaaS / general).
- OBJ_TIMELINE: Concerns about lack of developer resource, implementation timeline, onboarding speed, launch delay (SaaS / general).
- OBJ_SWITCHING: Friction of migrating from a current provider or vendor lock-in contracts.
- COMPETITOR: Mention of competitor platforms (Salesforce, HubSpot, Masai School, Scaler, etc.).
- SIGNAL_BUY: Asks for next steps, contracting, compliance/security docs, pricing sheets, pilot/demo, free aptitude scholarship test.
- INQUIRY: Standard complex product, course, or curriculum questions. Do not use for simple greetings or checking if this is Newton School.
- OBJ_ISA_FEES: Objections about course fees, registration fee, Income Share Agreement (ISA) terms, loan EMIs, or scholarship eligibility (Newton School context).
- OBJ_PLACEMENT: Concerns or questions about job placement assistance, CTC packages, LPA expectations, career cells, hiring partner network (Newton School context).
- OBJ_AFFILIATION: Concerns or questions about B.Tech degree credibility, UGC approval status, Rishihood University degree affiliation, or course certifications (Newton School context).
- NONE: Agreement sounds, small talk, general confirmation, simple greetings, or basic identification/neutral checks (e.g., "is this Newton School of Technology?", "hello", "who is this?", confirming name/location).

You MUST respond with a valid JSON object strictly adhering to this compressed format:
{
  "intents": [
    {
      "cat": "CATEGORY_CODE",
      "conf": 0.0-1.0,
      "entity": "EXTRACTED_ENTITY_OR_NULL"
    }
  ]
}

Ensure:
1. Short output generation. Keep intents array to only active categories.
2. Return ONLY JSON. Do not include markdown formatting or explanation outside JSON.`;
  }

  // Formats conversation history sliding window for context resolution
  formatContext(history, currentUtterance) {
    const contextLines = [];
    const window = history.slice(-this.contextWindowSize);
    
    for (const turn of window) {
      const label = turn.speaker === 0 ? "Rep" : "Customer";
      contextLines.push(`[${label}]: ${turn.text}`);
    }
    
    contextLines.push(`[Customer] (CURRENT): ${currentUtterance.text}`);
    return contextLines.join("\n");
  }

  // Main entrypoint: evaluates utterance, triggers reflex match, then schedules 8B cognitive router
  async detect(utterance, history = [], isCustomer = true) {
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

    // If it's the Rep speaking, we do not perform intent classification (only Customer statements trigger copilot cues)
    if (!isCustomer) {
      return makeEvent([]);
    }

    // 1. GATEKEEPER CHECK: Early exit on filler text (0ms latency)
    if (this.isFillerUtterance(utterance.text)) {
      console.log(`[EventDetector] Early exit (0ms) on filler text: "${utterance.text}"`);
      const event = makeEvent([]);
      this.emit('event', { ...event, isReflex: true, source: 'gatekeeper' });
      return event;
    }

    // 1.5. NEUTRAL/GREETING CHECK: Early exit on greeting/identification questions (0ms latency)
    if (this.isNeutralOrGreeting(utterance.text)) {
      console.log(`[EventDetector] Early exit (0ms) on neutral/greeting check: "${utterance.text}"`);
      const event = makeEvent([]);
      this.emit('event', { ...event, isReflex: true, source: 'neutral_filter' });
      return event;
    }

    // 2. REFLEX ROUTER CHECK: Instant regex rules match (<5ms latency)
    const regexIntents = this.runRegexRules(utterance.text);
    if (regexIntents.length > 0) {
      const reflexEvent = makeEvent(regexIntents);
      console.log(`[EventDetector] Instant Regex Match (<5ms):`, regexIntents);
      this.emit('event', { ...reflexEvent, isReflex: true, source: 'regex' });
      // Keep going to let LLM check details/other intents in background, but we emit reflex immediately!
    }

    // 3. COGNITIVE ROUTER (8B Model)
    // Run Ollama (or Cloud fallback) in parallel/background
    let llmIntents = [];
    const promptContext = this.formatContext(history, utterance);

    try {
      llmIntents = await this.queryOllama(promptContext);
    } catch (ollamaErr) {
      console.warn(`[EventDetector] Local Ollama failed or unreachable. FallbackToCloud enabled: ${this.fallbackToCloud}`, ollamaErr.message);
      if (this.fallbackToCloud) {
        try {
          llmIntents = await this.queryCloudFallback(promptContext);
        } catch (cloudErr) {
          console.error(`[EventDetector] Cloud fallbacks also failed:`, cloudErr.message);
        }
      }
    }

    // Merge and deduplicate reflex and cognitive intents
    const finalizedIntents = this.mergeIntents(regexIntents, llmIntents);
    const finalizedEvent = makeEvent(finalizedIntents);

    this.emit('event', { ...finalizedEvent, isReflex: false, source: 'cognitive' });
    return finalizedEvent;
  }

  // Local Ollama API call
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
          { role: 'user', content: `Analyze this conversational context and output structured JSON intents:\n\n${contextText}` }
        ],
        stream: false,
        format: 'json',
        options: {
          temperature: 0.0,
          num_predict: 150 // safe headroom limit to prevent JSON truncation
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama server returned status ${response.status}`);
    }

    const data = await response.json();
    const content = data.message?.content || "";
    return this.parseJSONIntents(content);
  }

  // Cloud API Fallback Router (Groq or Gemini)
  async queryCloudFallback(contextText) {
    const systemPrompt = this.getSystemPrompt();

    // 1. Try Groq Llama-3.1-8b-instant if key exists
    if (this.groqApiKey && this.groqApiKey !== "placeholder") {
      console.log(`[EventDetector] Fallback: Querying Groq (Llama-3.1-8b-instant)...`);
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
          max_tokens: 50,
          response_format: { type: "json_object" }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "";
        return this.parseJSONIntents(content);
      } else {
        console.warn(`[EventDetector] Groq fallback failed with status ${response.status}`);
      }
    }

    // 2. Try Gemini fallback if key exists
    if (this.geminiApiKey && this.geminiApiKey !== "placeholder") {
      console.log(`[EventDetector] Fallback: Querying Gemini API (gemini-2.5-flash)...`);
      
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: `${systemPrompt}\n\nAnalyze this conversation:\n\n${contextText}` }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.0,
            maxOutputTokens: 60
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        return this.parseJSONIntents(content);
      } else {
        console.warn(`[EventDetector] Gemini fallback failed with status ${response.status}`);
      }
    }

    throw new Error("No active cloud keys available or all APIs failed.");
  }

  // Safe parsing helper
  parseJSONIntents(jsonString) {
    try {
      const cleanJson = jsonString.trim();
      const parsed = JSON.parse(cleanJson);
      if (parsed && Array.isArray(parsed.intents)) {
        // Validate each item
        return parsed.intents.map(item => ({
          cat: String(item.cat || "NONE").toUpperCase(),
          conf: typeof item.conf === 'number' ? item.conf : 0.8,
          entity: item.entity ? String(item.entity) : null
        }));
      }
    } catch (e) {
      console.error(`[EventDetector] Failed to parse JSON content: "${jsonString}"`, e.message);
    }
    return [];
  }
}
