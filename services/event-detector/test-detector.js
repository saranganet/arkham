import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventDetector } from './detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the environment variables from the stt-proxy env file to fetch API keys
dotenv.config({ path: path.join(__dirname, '../stt-proxy/.env') });

async function runTests() {
  console.log("=== STARTING EVENT DETECTOR TEST HARNESS ===");
  console.log("Ollama Host: http://localhost:11434");
  console.log("Model: llama3.1:8b");
  console.log("--------------------------------------------");

  const detector = new EventDetector({
    playbook: 'saas',
    // Preserved options for friend's local test config:
    // ollamaUrl: 'http://localhost:11434',
    // modelName: 'gemma4:e4b' // 'llama3.1:8b'
  });

  // Listener to track emissions
  detector.on('event', (evt) => {
    const typeLabel = `🧠 COGNITIVE [${evt.source.toUpperCase()}]`;
    console.log(`\n[EMITTED EVENT - ${typeLabel}]`);
    console.log(`  Role: ${evt.role}`);
    console.log(`  Utterance: "${evt.utteranceId}"`);
    console.log(`  Intents:`, JSON.stringify(evt.intents, null, 2));
    console.log(`  Time elapsed: ${Date.now() - evt.timestamp}ms`);
  });

  const testCases = [
    {
      name: "Gatekeeper Early Exit Check",
      utterance: { id: "u1", speaker: 1, text: "Yeah." },
      history: []
    },
    {
      name: "Semantic Competitor Match (HubSpot)",
      utterance: { id: "u2", speaker: 1, text: "We are currently looking at HubSpot as well." },
      history: []
    },
    {
      name: "Semantic Timeline Objection (Ollama)",
      utterance: { id: "u3", speaker: 1, text: "I'm not sure we have enough engineer bandwidth to handle a 3-month integration cycle right now." },
      history: [
        { speaker: 0, text: "We can get you set up in a few weeks." }
      ]
    },
    {
      name: "Context Resolution (Anaphora Resolution)",
      utterance: { id: "u4", speaker: 1, text: "No, we actually use that instead." },
      history: [
        { speaker: 0, text: "Do you guys currently use Salesforce for your sales reps?" }
      ]
    },
    {
      name: "Rep Proactive Topic Transition (Pricing)",
      utterance: { id: "u5", speaker: 0, text: "Okay, let's talk about the fees and pricing options." },
      history: []
    },
    {
      name: "Codecademy Interest",
      utterance: { id: "u6", speaker: 1, text: "I've been looking into Codecademy for my team's development." },
      history: []
    },
    {
      name: "Meaningful Filler (Yeah answering a Rep Question)",
      utterance: { id: "u7", speaker: 1, text: "Yeah." },
      history: [
        { speaker: 0, text: "Do you want to book the career counseling session today?" }
      ]
    },
    {
      name: "Complex Small Talk (Zero-Shot Filter)",
      utterance: { id: "u8", speaker: 1, text: "I'm in Mumbai right now, it is super hot." },
      history: []
    },
    {
      name: "Complex Small Talk with Pleasantry (Zero-Shot Filter)",
      utterance: { id: "u9", speaker: 1, text: "The weather has been quite nice here lately, how is it over there?" },
      history: []
    },
    {
      name: "Playbook Keyword Bypass (Should NOT be filtered by Zero-Shot)",
      utterance: { id: "u10", speaker: 1, text: "Yes, I want to discuss the course fees and syllabus." },
      history: []
    }
  ];

  for (const tc of testCases) {
    console.log(`\n\n--------------------------------------------`);
    console.log(`RUNNING TEST CASE: ${tc.name}`);
    console.log(`Utterance: "${tc.utterance.text}" (Speaker: ${tc.utterance.speaker === 0 ? 'Rep' : 'Customer'})`);
    if (tc.history.length > 0) {
      console.log(`History:`);
      tc.history.forEach(h => console.log(`  [${h.speaker === 0 ? 'Rep' : 'Customer'}]: ${h.text}`));
    }
    
    const startTime = Date.now();
    const result = await detector.detect(tc.utterance, tc.history, tc.utterance.speaker !== 0);
    const latency = Date.now() - startTime;
    
    console.log(`\nResult returned synchronously:`);
    console.log(`  Latency: ${latency}ms`);
    console.log(`  Source: ${result.source}`);
    console.log(`  Intents:`, JSON.stringify(result.intents, null, 2));
  }

  // Test Real Estate Playbook
  console.log(`\n\n--------------------------------------------`);
  console.log(`RUNNING PLAYBOOK SWAP TEST (Real Estate)`);
  const reDetector = new EventDetector({
    playbook: 'realestate',
    // Preserved options for friend's local test config:
    // ollamaUrl: 'http://localhost:11434',
    // modelName: 'gemma4:e4b' // 'llama3.1:8b'
  });

  const reUtterance = { id: "re1", speaker: 1, text: "Honestly, the rate volatility has me terrified of buying a house this month." };
  const reStartTime = Date.now();
  const reResult = await reDetector.detect(reUtterance, []);
  console.log(`Real Estate Result (Latency: ${Date.now() - reStartTime}ms):`);
  console.log(JSON.stringify(reResult.intents, null, 2));

  console.log("\n============================================");
  console.log("=== TESTS COMPLETED ===");
}

runTests().catch(console.error);
