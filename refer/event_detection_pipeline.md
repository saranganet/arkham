# The Live Conversation Analytics & Event Detection Pipeline

This document provides a comprehensive, end-to-end technical breakdown of the Sales Copilot system. It traces the lifecycle of a spoken phrase from physical sound capture to real-time AI assistance, and finally to semantic check-off on the representative's screen, highlighting the exact lines in the codebase where each logic resides.

---

## 1. End-to-End Pipeline Architecture

The system utilizes a dual-path pipeline: a low-latency local gatekeeper path running on the Node.js server and client browser (~0ms–20ms), a local Speech Emotion Recognition (SER) path (~120ms), and a cognitive cloud path utilizing Groq's Llama 3.1 8B API and Tavily search (~100ms–250ms).

```mermaid
graph TD
    %% Stage 1: Capture & Aggregation
    subgraph Stage 1: Audio Capture & Aggregation
        A1[Sales Rep Microphone] -->|Left Channel - Ch 0| A3[Web Audio Mixer / Stereo Merger]
        A2[Browser / Tab Loopback Audio] -->|Right Channel - Ch 1| A3
        A3 -->|16kHz 2-Ch Interleaved Int16 PCM| B[stt-proxy Server]
        B -->|Accumulate Float32 Buffers| B_Buf[repAudioSamples / customerAudioSamples]
        B -->|Stream Raw PCM Bytes| C[Deepgram Live API]
        C -->|Multichannel Transcription JSON| B
        B -->|Speaker 0/1 Transcripts| D[Transcript Aggregator]
        D -->|Buffer & Merge Chunks| D
        D -->|Emit Finalized Utterance| E[Unified Processing Path]
    end

    %% Stage 2: Speech Emotion Recognition
    subgraph Stage 2: Speech Emotion Recognition
        E -->|Get Start/End Timestamps| SER_Slice[Extract Audio Waveform Slice]
        SER_Slice -->|Select Rep or Customer Buffer| SER_Inference[Local ONNX wav2vec2 Model]
        SER_Inference -->|Classify Tone & Probability| SER_Map[Map Emotion Tag: Calm/Happy/Agitated/Sad]
        SER_Map -->|Inject emotion & emotionScore| E
    end

    %% Stage 3: Unified Multi-Keyword Scan & Gatekeeper Funnel
    subgraph Stage 3: Unified Multi-Keyword Scan & Gatekeeper
        E -->|Scan Bypasses & Core Safeguards| K_Scan{Any Matched Keywords?}
        
        K_Scan -->|Yes| K_Exact{Any Exact Matches?}
        
        K_Exact -->|Yes| K_Direct[Push Exact Output Cards directly to UI]
        K_Direct --> K_Mixed{Any Guideline or AI Matches?}
        K_Mixed -->|No| Exit1[Exit Pipeline - 0ms AI Latency]
        K_Mixed -->|Yes| LLM1[Groq Llama 3.1 8B Classifier - LLM 1]
        
        K_Exact -->|No| LLM1
        
        K_Scan -->|No| H{Is Filler Utterance?}
        H -->|Yes| H_QA{isRespondingToQuestion?}
        H_QA -->|No| ExitGate[Gatekeeper Exit - Keep Screen Cards]
        H_QA -->|Yes| LLM1
        
        H -->|No| I{Is Simple Greeting?}
        I -->|Yes| ExitGate
        I -->|No| ZeroShot[Run Local Zero-Shot NLI]
        
        ZeroShot -->|"Score >= 80% Small Talk"| ExitZero[Exit - Keep Screen Cards]
        ZeroShot -->|"Score < 80% Small Talk"| LLM1
    end

    %% Stage 4 & 5: Classifier & early-exit
    subgraph Stage 4 & 5: Intent Classification & Early-Exit
        LLM1 -->|Extract Intents & suggested_search_query| L2[Filter NONE Intents]
        L2 --> L3{Intents Empty?}
        L3 -- Yes (Customer) --> L4[Push Clear Screen Signal]
        L3 -- Yes (Rep) --> Exit3[Exit - No screen changes]
        L3 -- No --> M1[Unified Query Resolution]
    end

    %% Stage 6 & 7: Search & Suggestions
    subgraph Stage 6 & 7: Contextual Search & Suggestions
        M1 --> M2{Category Override behavior?}
        M2 -- bypass --> M3[Use Exact Output override]
        M2 -- guideline/ai --> M4[Query Qdrant RAG / Local Mock using Search Query]
        M4 --> M5{"Has Confident RAG Match (>= 0.60)?"}
        M5 -- Yes --> M6[Assemble Prompt Context]
        M5 -- No --> M7[Tavily Search using same Search Query]
        M7 --> M7_Filter[Local MiniLM Relevance Filter]
        M7_Filter -->|Similarity >= 0.35| M6
        M7_Filter -->|Similarity < 0.35| M7_Discard[Discard Web Snippets]
        M7_Discard --> M6
        M3 --> N1[Groq Llama 3.1 8B Suggestion Generator - LLM 2]
        M6 --> N1
        N1 -->|Generate Grounded Suggestions / Fallbacks| O1[WebSocket Push to UI]
    end

    %% Stage 8 & 9: Rendering & Completion
    subgraph Stage 8 & 9: UI Rendering & Semantic Check-off
        O1 --> P1[React HUD Display]
        P1 --> P2[Web Audio API Chime + Panel Glow Alert + Emotion Badge]
        P1 --> P3[Jaccard Similarity Deduplication Check]
        P3 -->|Overlap > 55%| P4[Discard Suggestion Card]
        P3 -->|Unique| P5[Render Stacked Layout: slice -3]
        P5 --> P6[Slot 1: Current Card - 100% opacity, glow pulse]
        P5 --> P7[Slot 2: Previous Card - 40% opacity, scale 0.95]
        P5 --> Q1[Transformers.js embedding on Rep's spoken words]
        Q1 --> Q2{"Cosine Similarity > 0.65?"}
        Q2 -- Yes --> Q3[Mark Card Completed, flash emerald, slide out exit]
        Q2 -- No --> Q4[Persist Card on screen]
    end
```

---

## 2. Step-by-Step Processing Deep Dive

### Stage 1: Hardware Audio Capture & Multi-Channel Separation

1. **Physical Sound Input**:
   - The React UI client captures the Sales Rep's local voice via the browser's microphone input.
     * *Code Location*: [App.jsx: L309-318](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L309-L318) inside the `startRecordingSession()` routine.
   - Simultaneously, the client captures the incoming customer audio via tab or window audio loopback.
     * *Code Location*: [App.jsx: L322-337](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L322-L337) using `navigator.mediaDevices.getDisplayMedia`.
2. **Channel Separation Mixer & Downsampler**:
   - The React app instantiates a Web Audio API `AudioContext` and a `ChannelMergerNode` with `numberOfInputs = 2`. The context is created natively at **16,000 Hz** to perform client-side downsampling.
     * *Code Location*: [App.jsx: L347-357](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L347-L357).
   - The microphone stream is connected to input 0 (Left channel), and the browser/speaker loopback stream is connected to input 1 (Right channel).
   - This ensures **hardware-level stereo mapping**:
     - **Channel 0** is mathematically locked to the **Sales Rep** (`speaker: 0`).
     - **Channel 1** is mathematically locked to the **Customer** (`speaker: 1`).
3. **Lightweight PCM Streaming**:
   - A `ScriptProcessorNode` listens to the merger output. In `onaudioprocess`, it reads the Float32 samples from both channels, clamps/scales them, and packs them into interleaved 16-bit Int16 PCM binary chunks. These are sent over a WebSocket connection to the proxy server.
     * *Code Location*: [App.jsx: L368-398](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L368-L398).
4. **Deepgram Transcription Ingestion**:
   - The proxy receives raw binary PCM chunks and forwards them directly to Deepgram Live Streaming API configured with:
     - `encoding: 'linear16'`, `sample_rate: 16000`, `channels: 2`, `multichannel: true`.
     - `diarize: false`: AI speaker clustering is bypassed in favor of hardware-channel speaker mapping.
     - `endpointing: 500`: Enables Voice Activity Detection (VAD) with a 500ms silence threshold.
     - `smart_format: true`, `interim_results: true`.
     * *Code Location*: [server.js: L504-518](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L504-L518) inside the connection setup.
5. **Proxy Speaker Index Mapping**:
   - Deepgram returns JSON payloads containing transcribed text and the `channel_index` field (0 or 1).
   - The proxy maps `channel_index: 0` to `speaker: 0` (Rep) and `channel_index: 1` to `speaker: 1` (Customer).
     * *Code Location*: [server.js: L527-537](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L527-L537).

---

### Stage 2: Low-Latency Utterance Aggregation & Audio Buffering

1. **In-Memory Audio Buffering**:
   - As raw PCM chunks arrive on the WebSocket from the client, the server unpacks the interleaved Int16 frames into respective Float32 arrays (`repAudioSamples` and `customerAudioSamples`).
     * *Code Location*: [server.js: L559-577](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L559-L577).
2. **Utterance Finalization**:
   - The `TranscriptAggregator` merges word fragments into cohesive sentences. An utterance is finalized and flushed when:
     - **Rule 1: Punctuation Ending**: The incoming word chunk ends with a sentence terminator (`.`, `!`, `?`).
     - **Rule 2: VAD / Speech Final**: Deepgram triggers `speech_final: true`.
     - **Rule 3: Watchdog Timeout**: A fallback timer of 3000ms triggers if VAD and punctuation checks fail to fire.
     * *Code Location*: [Aggregator.js](file:///Users/arkapravorajkonwar/Documents/arkham/services/transcript-aggregator/Aggregator.js).

---

### Stage 3: Server-Side Speech Emotion Recognition (SER) (~120ms)

When `TranscriptAggregator` finalizes an utterance, the server performs vocal tone analysis on the raw audio slice corresponding to that utterance before sending the transcript to the client.

1. **Model Pre-loading**:
   - The server loads the **`onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX`** model using `@xenova/transformers` on startup.
     * *Code Location*: [server.js: L220-L227](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L220-L227).
2. **Audio Slice Extraction**:
   - Maps Deepgram's `start` and `end` timestamps (in seconds) directly to sample offsets:
     $$\text{sampleIndex} = \text{Time} \times 16,000$$
   - Extracts the Float32 samples from the respective speaker's buffer.
     * *Code Location*: [server.js: L229-L238](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L229-L238) inside `getAudioSlice()`.
3. **Local ONNX Classification**:
   - Runs model inference on the extracted slice (requiring at least 0.5 seconds of audio).
   - Maps the predicted raw emotion (e.g. `NEUTRAL`, `HAPPY`, `ANGRY`, `SAD`, `FEAR`, `DISGUST`) to friendly user tags:
     - `NEUTRAL` $\to$ `Calm`
     - `HAPPY` $\to$ `Happy`
     - `ANGRY` $\to$ `Agitated`
     - `SAD` $\to$ `Sad`
     - `FEAR` $\to$ `Anxious`
     - `DISGUST` $\to$ `Irritated`
     * *Code Location*: [server.js: L240-L258](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L240-L258) inside `mapEmotionLabel()`.
4. **Payload Injection**:
   - Injects the `emotion` and `emotionScore` directly into the `finalized_utterance` JSON payload.
     * *Code Location*: [server.js: L261-L285](file:///Users/arkapravorajkonwar/Documents/arkham/services/stt-proxy/server.js#L261-L285) inside `aggregator.on('utterance')`.

---

### Stage 4: Local Gatekeeper Funnel & Question-Answering Routing (~0ms–20ms)

To minimize Groq cloud API costs and reduce response latency, the system routes the finalized text through a local gatekeeper funnel. Rep and Customer utterances are treated through the exact same processing pipeline.

1. **Step A: Question-Answering Context Resolution**:
   - Checks if the current speaker is responding to a question from the other speaker.
     * *Code Location*: [detector.js: L203-L218](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L203-L218).
2. **Step B: Filler Check (0ms)**:
   - Filters out short, low-content filler words (e.g. *yeah, ok, mhm, no*) under 4 words, unless they are replying to a direct question context.
     * *Code Location*: [detector.js: L89-L99](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L89-L99); checked at [detector.js: L220-L226](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L220-L226).
3. **Step C: Simple Greeting Check (0ms)**:
   - Filters out basic greetings (*"hello, hi, good morning"*) via a lightweight, fast regex check: `/^(hello|hi|hey|good morning|yo)$/`.
     * *Code Location*: [detector.js: L101-L106](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L101-L106); checked at [detector.js: L228-L232](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L228-L232).
4. **Step D: Sales Keyword Context Bypass**:
   - Inspects the active context text (`textToClassify` containing the preceding question context if replying). If any playbook-specific keyword from `playbooks.json` is hit, it bypasses NLI zero-shot classification and routes directly to Groq LLM 1.
     * *Code Location*: `hasSalesKeyword()` at [detector.js: L79-L83](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L79-L83); checked at [detector.js: L213-L219](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L213-L219).
5. **Step E: Local Zero-Shot Semantic Filter (20ms)**:
   - If no context keywords match, the server runs a local NLI model inside the Node process (`Xenova/nli-deberta-v3-small`) to score the text against two highly contrastive labels: `neutral greeting/brand check/small talk` vs `sales objection/business query`. If the small talk score is >= 70%, the pipeline exits early.
     * *Code Location*: [detector.js: L66-L86](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L66-L86); checked at [detector.js: L220-L231](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L220-L231).

---

### Stage 5: Intent Classification & Search Query Generation (LLM 1) (~120ms)

If the local gatekeeper funnel is bypassed, the proxy server sends the conversation history to the Groq Llama 3.1 8B Classifier (`llama-3.1-8b-instant`):

1. **System Prompt Category Schema**: The classifier categorizes the utterance using shortened, topic-focused keys:
   - `FEES`, `PLACEMENT`, `DEGREE`, `BUDGET`, `TIMELINE`, `SWITCHING`, `COMPETITOR`, `BUY_SIGNAL`, `INQUIRY`, `NONE`.
   - *Code Location*: System prompt definition is at [detector.js: L186-L221](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L186-L221).
2. **Search Query Generation**: Under instructions in the system prompt, LLM 1 generates a context-complete keyword search query (`suggested_search_query`), resolving pronouns using the sliding window context.
3. **Structured Output & Groq Call**:
   - Resides in `queryGroq()` at [detector.js: L331-L364](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/event-detector/detector.js#L331-L364).
4. **Early Exit Validation**:
   - `NONE` categories are removed via `mergeIntents()`. If empty, Customer statements push a clear screen signal (`"Great job, keep going!"`), while Rep statements exit silently.
     * *Code Location*: Exits handled in [server.js: L307-L330](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L307-L330).

### Stage 6: Context Retrieval & Real-Time Competitor Web Search (~150ms)

If active intents are identified, the proxy server retrieves supporting context:

1. **Manager Category Bypasses & Overrides**:
   - The system inspects category configurations dynamically from `categories.json`. If an active category behavior matches `"bypass"`, it directly pushes the category's `"exactOutput"` and exits early, saving RAG and LLM 2 token latency.
     * *Code Location*: Checked at [server.js: L319-L342](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L319-L342).
2. **Unified Query Resolution & Vector RAG**:
   - If no direct override exists, the system uses the LLM 1-generated `suggested_search_query` (falling back to `utt.text`) to query the vector RAG database.
   - Vectors are computed using `Xenova/all-MiniLM-L6-v2` locally to perform cosine similarity searches in the playbook partition.
     * *Code Location*: [rag.js: L143-L199](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/rag.js#L143-L199), triggered at [server.js: L350-L364](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L350-L364).
3. **Real-Time Tavily Search Fallback & MiniLM Relevance Filter**:
   - If the best local RAG match score is below the confidence threshold (`0.60`), or if an unknown competitor/entity is mentioned, the system automatically triggers a Tavily web search using the *same* `suggested_search_query`.
   - **Local Relevance Scoring**: Each retrieved web snippet is compared against the search query using the local `calculateRelevance` utility in `rag.js`. Only snippets with a similarity score >= 0.35 are combined with the local RAG guidelines into the prompt context.
     * *Code Location*: Tavily API search wrapper is at [server.js: L78-L115](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L78-L115); triggered and filtered at [server.js: L353-L402](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L353-L402).

---

### Stage 7: Suggestion Generation (LLM 2) (~150ms)

The aggregated guidelines, Tavily search snippets, and conversation logs are sent to the Groq Llama 3.1 8B Suggestion Generator (`llama-3.1-8b-instant`):

1. **System Prompt & Constraints**:
   - Outputs a maximum of 2 to 3 bullet points, formatted strictly as direction cues with a single suggested respond phrase in parentheses: `(Say: "...")`.
   - **Strict Grounding Rule**: Instructions verify if the provided guidelines or search snippets answer the customer's query. If facts are missing or irrelevant, it outputs a fallback cue card to defer answering.
     * *Code Location*: System prompt construction is at [server.js: L413-L423](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L413-L423).
2. **Groq Execution**:
   - Resides in [server.js: L436-L462](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/services/stt-proxy/server.js#L436-L462).

---

### Stage 8: WebSocket Push, UI Rendering & Chime Alerts

1. **UI Parsing & Small Talk Filtration**:
   - The React app parses the incoming suggestions, stripping out bullets and isolating the `(Say: "...")` phrase.
     * *Code Location*: [App.jsx: L541-L599](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L541-L599).
2. **Web Audio Chime & Visual Flash**:
   - For new unique suggestions, the app synthesizes a clean **880Hz electronic chime** using the browser's Web Audio API and triggers a glowing CSS alert.
     * *Code Location*: [App.jsx: L459-L482](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L459-L482).
3. **Jaccard Similarity Deduplication**:
   - Compares incoming cards against active cards using a Jaccard Word-Similarity index to filter duplicates.
     * *Code Location*: Jaccard overlap helper is at [App.jsx: L160-L190](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L160-L190); checked inside the queue updater at [App.jsx: L601-L620](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L601-L620).
4. **Live Emotion & Sentiment Badge Rendering**:
   - Displays the friendly emotion name along with the weighted sentiment score in parentheses (e.g. `Agitated (-0.90)`) next to the speaker label.
     * *Code Location*: [App.jsx: L1023-L1035](file:///Users/arkapravorajkonwar/Documents/arkham/packages/ui/src/App.jsx#L1023-L1035).

---

### Stage 9: Closing the Loop: Semantic Check-off & Inverted 2-Card Cascade

As the Sales Rep speaks, the system automatically checks off items as they say them, and transitions the layout using a stacked cascade:

1. **Local Browser Embedder**:
   - Loads a quantized, INT8 version of the **`all-MiniLM-L6-v2`** model on mount.
     * *Code Location*: [App.jsx: L107-L124](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/packages/ui/src/App.jsx#L107-L124).
2. **Cosine Similarity Helper**:
   - Computes cosine similarity between Rep's spoken vector and target suggestion cards.
     * *Code Location*: [App.jsx: L141-L155](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/packages/ui/src/App.jsx#L141-L155).
3. **Semantic Completion Engine Loop**:
   - If similarity > 0.65, marks cards completed.
     * *Code Location*: Embedding generation and check-off logic is at [App.jsx: L200-L266](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/packages/ui/src/App.jsx#L200-L266).
4. **Inverted 2-Card Cascading Layout**:
   - Only the last 2 cue cards from `focusQueue` are active. Slot 1 (Current Card) is highlighted with an alert border pulse. Slot 2 (Previous Card) is scaled down to 0.95 and set to 40% opacity. Cards transition downward, with discarded cards sliding out via `@keyframes slideOutDown`.
     * *Code Location*: Rendering logic at [App.jsx: L1117-L1155](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/packages/ui/src/App.jsx#L1117-L1155), CSS transitions at [App.css: L1388-L1442](file:///Users/arkapravorajkonwar/Documents/bruh/arkham/packages/ui/src/App.css#L1388-L1442).
