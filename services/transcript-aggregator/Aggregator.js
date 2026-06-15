import { EventEmitter } from 'events';
import crypto from 'crypto';

export class TranscriptAggregator extends EventEmitter {
  constructor(options = {}) {
    super();
    // 3 seconds absolute fallback in case VAD fails and no punctuation is found
    this.watchdogTimeout = options.watchdogTimeout || 3000; 
    this.activeUtterances = new Map(); 
  }

  // Receives a Deepgram `is_final` data object
  processChunk(data) {
    if (!data || !data.is_final || !data.channel?.alternatives?.[0]) return;
    
    const alternative = data.channel.alternatives[0];
    const words = alternative.words || [];
    const isSpeechFinal = data.speech_final === true;

    // Track which speakers added words during this specific chunk
    const activeSpeakersInChunk = new Set();

    for (const wordObj of words) {
      const speaker = wordObj.speaker !== undefined ? wordObj.speaker : 0;
      activeSpeakersInChunk.add(speaker);
      
      let active = this.activeUtterances.get(speaker);

      if (!active) {
        active = {
          speaker,
          start: wordObj.start,
          end: wordObj.end,
          words: [],
          text: '',
          timer: null
        };
        this.activeUtterances.set(speaker, active);
      }

      // Clear the existing watchdog timer for this speaker
      if (active.timer) {
        clearTimeout(active.timer);
      }

      active.words.push(wordObj);
      active.end = wordObj.end;
      
      // Update text
      const wordText = wordObj.punctuated_word || wordObj.word;
      active.text = active.text ? `${active.text} ${wordText}` : wordText;

      // RULE 1: Punctuation (Handles fast talkers who don't pause)
      if (wordText.match(/[.!?]$/)) {
        this.finalizeUtterance(speaker);
        activeSpeakersInChunk.delete(speaker); // No longer active if finalized
        active = null; 
      } else {
        // Set the fallback watchdog timer
        active.timer = setTimeout(() => {
          this.finalizeUtterance(speaker);
        }, this.watchdogTimeout);
      }
    }

    // RULE 2: VAD / Speech Final (Handles natural pauses)
    if (isSpeechFinal) {
      for (const speaker of activeSpeakersInChunk) {
        this.finalizeUtterance(speaker);
      }
    }
  }

  finalizeUtterance(speaker) {
    const active = this.activeUtterances.get(speaker);
    if (!active || active.words.length === 0) return;

    // Kill the watchdog timer
    if (active.timer) {
      clearTimeout(active.timer);
    }

    const finalizedEvent = {
      id: crypto.randomUUID(),
      speaker: active.speaker,
      text: active.text.trim(),
      start: active.start,
      end: active.end,
      timestamp: Date.now()
    };

    // Emit the event to be picked up by Event Detectors / NATS
    this.emit('utterance', finalizedEvent);
    
    // Clear the active utterance for this speaker
    this.activeUtterances.delete(speaker);
  }

  // Force finalize all active utterances (e.g. at the end of a call)
  flush() {
    for (const speaker of this.activeUtterances.keys()) {
      this.finalizeUtterance(speaker);
    }
  }
}
