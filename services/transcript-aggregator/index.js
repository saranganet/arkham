import { TranscriptAggregator } from './Aggregator.js';

console.log("Starting Transcript Aggregator Service (VAD + Punctuation + Watchdog)...");

const aggregator = new TranscriptAggregator({ watchdogTimeout: 2000 });

// Listen for finalized utterances
aggregator.on('utterance', (utterance) => {
  console.log(`\n✅ [FINALIZED UTTERANCE] Speaker ${utterance.speaker}: "${utterance.text}"`);
  console.log(`   ⏱️ Time: ${utterance.start.toFixed(2)}s - ${utterance.end.toFixed(2)}s`);
  console.log(`   🔗 Event ID: ${utterance.id}`);
});

// Simulate receiving Deepgram STT chunks
const simulatedDeepgramChunks = [
  {
    // Chunk 1: No punctuation, no speech_final
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ words: [
      { word: "hi", punctuated_word: "Hi", speaker: 0, start: 1.0, end: 1.2 },
      { word: "im", punctuated_word: "I'm", speaker: 0, start: 1.2, end: 1.4 },
      { word: "calling", punctuated_word: "calling", speaker: 0, start: 1.4, end: 1.7 },
    ]}] }
  },
  {
    // Chunk 2: VAD triggers (speech_final = true). Triggers Rule 2!
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ words: [
      { word: "from", punctuated_word: "from", speaker: 0, start: 1.7, end: 1.9 },
      { word: "hubspot", punctuated_word: "HubSpot", speaker: 0, start: 1.9, end: 2.3 },
    ]}] }
  },
  {
    // Chunk 3: Punctuation triggers (fast talker). Triggers Rule 1!
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ words: [
      { word: "what", punctuated_word: "What", speaker: 1, start: 3.5, end: 3.8 },
      { word: "is", punctuated_word: "is", speaker: 1, start: 3.8, end: 4.0 },
      { word: "your", punctuated_word: "your", speaker: 1, start: 4.0, end: 4.2 },
      { word: "pricing", punctuated_word: "pricing?", speaker: 1, start: 4.2, end: 4.8 }, // Question mark triggers finalization
    ]}] }
  },
  {
    // Chunk 4: Mumble/trailing off. No punctuation, no VAD. Triggers Watchdog Timer!
    is_final: true,
    speech_final: false,
    channel: { alternatives: [{ words: [
      { word: "well", punctuated_word: "Well,", speaker: 1, start: 5.5, end: 5.8 },
      { word: "i", punctuated_word: "I", speaker: 1, start: 5.8, end: 6.0 },
      { word: "was", punctuated_word: "was", speaker: 1, start: 6.0, end: 6.2 },
      { word: "thinking", punctuated_word: "thinking", speaker: 1, start: 6.2, end: 6.8 },
    ]}] }
  }
];

// Simulate streaming
simulatedDeepgramChunks.forEach((chunk, index) => {
  setTimeout(() => {
    console.log(`\n📥 --- Received STT Chunk ${index + 1} from Deepgram ---`);
    console.log(`   speech_final: ${chunk.speech_final}`);
    const text = chunk.channel.alternatives[0].words.map(w => w.punctuated_word).join(' ');
    console.log(`   Raw: "${text}"`);
    aggregator.processChunk(chunk);
  }, index * 1000);
});
