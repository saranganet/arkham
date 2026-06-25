import { EventEmitter } from 'events';
import crypto from 'crypto';
import { pipeline, env } from '@xenova/transformers';

// Set the cache directory inside the local workspace to avoid sandbox file permission issues
env.cacheDir = './.cache';
env.allowLocalModels = false;

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
export const CATEGORY_MAP = {
  BUDGET: "Pricing, Cost & Budget Concerns",
  TIMELINE: "Timeline, Scheduling & Onboarding Speed",
  SWITCHING: "Switching Providers & Contract Lock-in",
  COMPETITOR: "Competitor Mentioned",
  BUY_SIGNAL: "Buying Signal / Next Steps",
  INQUIRY: "Product / General Inquiry",
  NONE: "No Specific Objection / Topic",
  FEES: "Fees, Financing & Scholarships",
  PLACEMENT: "Job Placements, CTC & Career Support",
  DEGREE: "Degree Accreditation & Rishihood University Affiliation"
};

// Playbook & Business keywords to bypass zero-shot checking instantly
const SALES_KEYWORDS = new Set([
  'fee', 'fees', 'pricing', 'cost', 'payment', 'isa', 'income share', 
  'installment', 'emi', 'loan', 'scholarship', 'scholarships', 'refund', 'placement', 
  'placements', 'package', 'job', 'jobs', 'hire', 'hiring', 'salary', 'lpa', 'ctc', 'career', 
  'degree', 'university', 'affiliation', 'ugc', 'accredited', 'rishihood',
  'integration', 'security', 'timeline', 'objection', 'competitor', 'competitors',
  'salesforce', 'hubspot', 'zoho', 'demo', 'trial', 'api', 'contract', 'price',
  'masai', 'scaler', 'upgrad', 'simplilearn', 'book', 'connect', 'schedule', 'call', 
  'meet', 'meeting', 'test', 'aptitude', 'enroll', 'register', 'calendar', 'tuesday', 
  'monday', 'wednesday', 'thursday', 'friday', 'next week', 'course', 'curriculum', 
  'syllabus', 'classes', 'class', 'learn', 'learning', 'program',
  'compare', 'comparison', 'vs', 'versus', 'alternative', 'alternatives', 
  'differ', 'difference', 'different', 'other', 'others', 'another', 
  'better', 'worse', 'cheaper', 'cheap', 'expensive', 'pricey', 'costly', 
  'coding ninjas', 'codingninjas', 'ninjas', 'geekster', 'prepbytes', 
  'codingblocks', 'coding blocks', 'udemy', 'coursera', 'edx', 'great learning', 
  'greatlearning', 'ineuron', 'pw skills', 'pwskills'
]);

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
    return Array.from(SALES_KEYWORDS).some(kw => lowerText.includes(kw));
  }

  async isZeroShotSmallTalk(text) {
    try {
      const classifier = await this.initClassifier();
      if (!classifier) return false;

      const candidateLabels = [
        'small talk or pleasantry or greeting',
        'sales course admission inquiry or objection'
      ];
      
      const result = await classifier(text, candidateLabels);
      const smallTalkIndex = result.labels.indexOf('small talk or pleasantry or greeting');
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

  // Filters out neutral or NONE classifications
  mergeIntents(llmIntents) {
    return llmIntents.filter(item => item.cat !== "NONE");
  }

  // Construct the system prompt for the 8B parameter model
  getSystemPrompt() {
    const chosenPlaybook = PLAYBOOKS[this.playbook] || PLAYBOOKS.general;
    return `You are a high-performance sales conversation router. Your task is to analyze the speaker's utterance (Rep or Customer) in a sales call and classify the underlying sales intent, objection, or proactive topic transition.

Configured Playbook: "${chosenPlaybook.name}"
Playbook Focus Guidelines: ${chosenPlaybook.guidelines}

Classification Schema ("cat" code):
- BUDGET: Concerns or questions about cost, pricing, fees, expensive subscriptions, or discount requests.
- TIMELINE: Concerns or questions about implementation timeline, onboarding speed, scheduling, class timing, or launch delays.
- SWITCHING: Friction or questions about migrating from a current provider, switching career tracks, or vendor lock-in contracts.
- COMPETITOR: Mention of competitor platforms or schools (Salesforce, HubSpot, Masai School, Scaler, Coding Ninjas, etc.).
- BUY_SIGNAL: Asks for next steps, scheduling, booking a session, taking a free aptitude/scholarship test, or explicitly agreeing to a Rep's direct next-step proposal.
- INQUIRY: Standard product, course, curriculum, syllabus, or general questions.
- FEES: Concerns or questions about course fees, ISA terms, loan EMIs, payment structures, or scholarship details (Newton School context).
- PLACEMENT: Concerns or questions about job placement support, CTC packages, LPA expectations, or partner networks (Newton School context).
- DEGREE: Concerns or questions about degree credibility, UGC approval, or Rishihood University affiliation (Newton School context).
- NONE: General backchanneling/agreement (e.g. "yeah" when Rep is talking), small talk, basic greetings, or neutral identification checks.

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
2. Return ONLY JSON. Do not include markdown formatting or explanation outside JSON.
3. For the "entity" field, extract the specific subject name from the text (e.g., if category is COMPETITOR, extract the specific name of the competitor mentioned, even if not listed in the examples. If no specific entity name is mentioned, return null).`;
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

    // Find the last Rep utterance in history to see if it was a question
    let lastRepUtterance = null;
    const repId = repSpeakerId !== null ? String(repSpeakerId) : "0";
    for (let i = history.length - 1; i >= 0; i--) {
      if (String(history[i].speaker) === repId) {
        lastRepUtterance = history[i].text;
        break;
      }
    }

    let isRespondingToQuestion = false;
    if (lastRepUtterance) {
      const cleanRepText = lastRepUtterance.trim();
      isRespondingToQuestion = cleanRepText.endsWith('?') || 
                               /\b(would|should|could|can|do|does|did|is|are|shall|will|how|what|why|where|who)\b.*\b(you|we|i|it|this|that|go|like|want|start|book|take|proceed)\b/i.test(cleanRepText);
    }

    // 1. GATEKEEPER CHECK: Early exit on filler text (0ms latency), unless responding to a Rep question
    if (this.isFillerUtterance(utterance.text) && !isRespondingToQuestion) {
      console.log(`[EventDetector] Early exit (0ms) on filler text: "${utterance.text}"`);
      const event = { ...makeEvent([]), source: 'gatekeeper' };
      this.emit('event', { ...event, isReflex: true });
      return event;
    }

    // 1.5. NEUTRAL/GREETING CHECK: Early exit on greeting/identification questions (0ms latency)
    if (this.isNeutralOrGreeting(utterance.text)) {
      console.log(`[EventDetector] Early exit (0ms) on neutral/greeting check: "${utterance.text}"`);
      const event = { ...makeEvent([]), source: 'neutral_filter' };
      this.emit('event', { ...event, isReflex: true });
      return event;
    }

    // 1.7. LOCAL ZERO-SHOT CHECK: Early exit on complex small talk
    if (!isRespondingToQuestion && !this.hasSalesKeyword(utterance.text)) {
      console.log(`[EventDetector] Running local Zero-Shot Classifier check...`);
      const isSmallTalk = await this.isZeroShotSmallTalk(utterance.text);
      if (isSmallTalk) {
        console.log(`[EventDetector] Early exit (local zero-shot) on small talk: "${utterance.text}"`);
        const event = { ...makeEvent([]), source: 'local_zeroshot' };
        this.emit('event', { ...event, isReflex: true });
        return event;
      }
    }

    // 2. COGNITIVE ROUTER (Groq Llama 3.1 8B)
    let llmIntents = [];
    const promptContext = this.formatContext(history, utterance, repSpeakerId);

    if (this.groqApiKey && this.groqApiKey !== "placeholder") {
      try {
        console.log(`[EventDetector] Routing classification query to Groq (Llama 3.1 8B)...`);
        llmIntents = await this.queryGroq(promptContext);
      } catch (err) {
        console.error(`[EventDetector] Groq classification failed:`, err.message);
      }
    } else {
      console.warn(`[EventDetector] Groq API Key is not set or placeholder.`);
    }

    // Filter neutral intents
    const finalizedIntents = this.mergeIntents(llmIntents);
    const finalizedEvent = { ...makeEvent(finalizedIntents), source: 'cognitive' };

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
