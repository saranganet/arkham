import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventDetector } from './detector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load the environment variables from the stt-proxy env file to fetch API keys
dotenv.config({ path: path.join(__dirname, '../stt-proxy/public/.env') });

async function runTests() {
  console.log("=== STARTING EVENT DETECTOR TEST HARNESS ===");
  console.log("Ollama Host: http://localhost:11434");
  console.log("Model: llama3.1:8b");
  console.log("--------------------------------------------");

  const detector = new EventDetector({
    ollamaUrl: 'http://localhost:11434',
    modelName: 'llama3.1:8b',
    playbook: 'saas',
    fallbackToCloud: true
  });

  // Listener to track emissions
  detector.on('event', (evt) => {
    const typeLabel = evt.isReflex ? `⚡ REFLEX [${evt.source.toUpperCase()}]` : `🧠 COGNITIVE [${evt.source.toUpperCase()}]`;
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
      name: "Instant Regex Competitor Match",
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
    }
  ];

  for (const tc of testCases) {
    console.log(`\n\n--------------------------------------------`);
    console.log(`RUNNING TEST CASE: ${tc.name}`);
    console.log(`Customer Utterance: "${tc.utterance.text}"`);
    if (tc.history.length > 0) {
      console.log(`History:`);
      tc.history.forEach(h => console.log(`  [${h.speaker === 0 ? 'Rep' : 'Customer'}]: ${h.text}`));
    }
    
    const startTime = Date.now();
    const result = await detector.detect(tc.utterance, tc.history);
    const latency = Date.now() - startTime;
    
    console.log(`\nResult returned synchronously:`);
    console.log(`  Latency: ${latency}ms`);
    console.log(`  Intents:`, JSON.stringify(result.intents, null, 2));
  }

  // Test Real Estate Playbook
  console.log(`\n\n--------------------------------------------`);
  console.log(`RUNNING PLAYBOOK SWAP TEST (Real Estate)`);
  const reDetector = new EventDetector({
    ollamaUrl: 'http://localhost:11434',
    modelName: 'llama3.1:8b',
    playbook: 'realestate'
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
