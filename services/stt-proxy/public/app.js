// SonicScribe - Frontend Client Logic

// State variables
let socket = null;
let mediaRecorder = null;
let audioStream = null;
let audioContext = null;
let analyser = null;
let dataArray = null;
let drawVisualId = null;

let isRecording = false;
let packetCount = 0;
let transcriptHistoryList = [];
let interimText = "";
let lastSpeaker = null;

// DOM Elements
const btnRecord = document.getElementById("btn-record");
const btnRecordText = document.getElementById("btn-record-text");
const selectModel = document.getElementById("select-model");
const selectLanguage = document.getElementById("select-language");
const checkSmartFormat = document.getElementById("check-smartformat");
const checkInterim = document.getElementById("check-interim");
const checkDiarize = document.getElementById("check-diarize");
const valPackets = document.getElementById("val-packets");
const visualizer = document.getElementById("visualizer");
const visualizerFallback = document.getElementById("visualizer-fallback");
const transcriptHistory = document.getElementById("transcript-history");
const transcriptPlaceholder = document.getElementById("transcript-placeholder");
const transcriptInterim = document.getElementById("transcript-interim");
const transcriptInterimWrapper = document.getElementById("transcript-interim-wrapper");
const transcriptMeta = document.getElementById("transcript-meta");
const btnCopy = document.getElementById("btn-copy");
const btnDownload = document.getElementById("btn-download");
const btnClear = document.getElementById("btn-clear");
const errorBanner = document.getElementById("error-banner");
const errorMessage = document.getElementById("error-message");
const btnCloseError = document.getElementById("btn-close-error");

// Status Badges
const statusMic = document.getElementById("status-mic");
const statusServer = document.getElementById("status-server");
const statusDeepgram = document.getElementById("status-deepgram");

// Setup Canvas context
const canvasCtx = visualizer.getContext("2d");

// Browser Feature Check
const isBrowserSupported = !!(
  navigator.mediaDevices &&
  navigator.mediaDevices.getUserMedia &&
  (window.AudioContext || window.webkitAudioContext) &&
  window.MediaRecorder
);

if (!isBrowserSupported) {
  showError("Your browser does not support necessary audio recording and Web Audio APIs. Please try using a modern version of Chrome, Firefox, or Safari.");
  btnRecord.disabled = true;
}

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------

btnRecord.addEventListener("click", toggleRecording);
btnCopy.addEventListener("click", copyTranscriptToClipboard);
btnDownload.addEventListener("click", downloadTranscript);
btnClear.addEventListener("click", clearTranscript);
btnCloseError.addEventListener("click", hideError);

// Resize canvas drawing buffer if necessary on init
function resizeCanvas() {
  const rect = visualizer.getBoundingClientRect();
  visualizer.width = rect.width;
  visualizer.height = rect.height;
}
window.addEventListener("resize", resizeCanvas);
resizeCanvas();

// -------------------------------------------------------------
// CORE FUNCTIONS
// -------------------------------------------------------------

async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  hideError();
  packetCount = 0;
  valPackets.textContent = "0";
  lastSpeaker = null; // Reset speaker state for the new session
  
  try {
    // 1. Request microphone access
    updateStatus(statusMic, "dot-active", "Mic: Requested");
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    updateStatus(statusMic, "dot-success", "Mic: Allowed");
  } catch (err) {
    console.error("Microphone permission denied:", err);
    updateStatus(statusMic, "dot-inactive", "Mic: Blocked");
    showError("Could not access microphone. Please ensure microphone permissions are granted.");
    return;
  }

  isRecording = true;
  btnRecord.classList.add("recording-active");
  btnRecordText.textContent = "Connecting...";
  btnRecord.disabled = true; // disable until WS is connected

  // 2. Initialize Web Audio API for Canvas Visualizer
  initVisualizer(audioStream);

  // 3. Connect to proxy WebSocket server
  connectProxyWebSocket();
}

function stopRecording() {
  isRecording = false;
  
  // Update Buttons
  btnRecord.classList.remove("recording-active");
  btnRecordText.textContent = "Start Recording";
  btnRecord.disabled = false;

  // Clean up mic status
  updateStatus(statusMic, "dot-inactive", "Mic: Inactive");

  // Clean up MediaRecorder
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      mediaRecorder.stop();
    } catch (e) {
      console.error(e);
    }
  }
  mediaRecorder = null;

  // Clean up mic streams
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  // Stop visualizer loop
  if (drawVisualId) {
    cancelAnimationFrame(drawVisualId);
    drawVisualId = null;
  }
  clearCanvas();
  visualizerFallback.classList.remove("hidden");

  // Clean up WebSocket
  if (socket) {
    socket.close();
    socket = null;
  }
  
  updateStatus(statusServer, "dot-inactive", "Server: Off");
  updateStatus(statusDeepgram, "dot-inactive", "Deepgram: Off");

  // Clean up interim
  interimText = "";
  transcriptInterim.textContent = "";
  transcriptInterimWrapper.classList.add("hidden");
}

// -------------------------------------------------------------
// WEBSOCKET INTEGRATION
// -------------------------------------------------------------

function connectProxyWebSocket() {
  updateStatus(statusServer, "dot-active", "Server: Connecting");
  
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "localhost:3000";
  
  // Read current config parameters
  const model = selectModel.value;
  const language = selectLanguage.value;
  const smartFormat = checkSmartFormat.checked;
  const interimResults = checkInterim.checked;
  const diarize = checkDiarize.checked;

  const wsUrl = `${protocol}//${host}?model=${model}&language=${language}&smart_format=${smartFormat}&interim_results=${interimResults}&diarize=${diarize}`;
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log("WebSocket Connection to proxy server opened.");
    updateStatus(statusServer, "dot-success", "Server: Connected");
    updateStatus(statusDeepgram, "dot-active", "Deepgram: Connecting");
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      
      if (payload.type === "status") {
        console.log("Proxy server status:", payload.message);
        if (payload.status === "connected") {
          updateStatus(statusDeepgram, "dot-success", "Deepgram: Live");
          
          // Re-enable record button (acting as Stop button now)
          btnRecord.disabled = false;
          btnRecordText.textContent = "Stop Recording";
          updateStatus(statusMic, "dot-recording", "Mic: Recording");
          
          // Start actual media capture now that connections are hot
          startMediaCapture();
        }
      } else if (payload.type === "transcript") {
        handleDeepgramResponse(payload.data);
      } else if (payload.type === "error") {
        showError(payload.message);
        stopRecording();
      }
    } catch (err) {
      console.error("Error parsing WebSocket message:", err);
    }
  };

  socket.onerror = (err) => {
    console.error("WebSocket client connection error:", err);
    showError("WebSocket error. Check if the backend server is running.");
    stopRecording();
  };

  socket.onclose = (event) => {
    console.log("WebSocket client connection closed:", event);
    if (isRecording) {
      stopRecording();
    }
  };
}

// -------------------------------------------------------------
// AUDIO MEDIA CAPTURE
// -------------------------------------------------------------

function startMediaCapture() {
  // Check supported audio format codecs
  let mimeType = "audio/webm";
  if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
    mimeType = "audio/webm;codecs=opus";
  } else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) {
    mimeType = "audio/ogg;codecs=opus";
  }
  
  console.log(`Using MIME type: ${mimeType}`);

  try {
    mediaRecorder = new MediaRecorder(audioStream, { mimeType });
  } catch (err) {
    console.error("Failed to initialize MediaRecorder:", err);
    showError("Failed to start MediaRecorder: " + err.message);
    stopRecording();
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0 && socket && socket.readyState === WebSocket.OPEN) {
      // Send raw binary audio chunk to the WebSocket server
      socket.send(event.data);
      packetCount++;
      valPackets.textContent = packetCount;
    }
  };

  // Slice audio data into 250ms chunks for low-latency streaming
  mediaRecorder.start(250);
}

// -------------------------------------------------------------
// DEEPGRAM TRANSCRIPT PARSING
// -------------------------------------------------------------

function handleDeepgramResponse(data) {
  // Verify structures
  if (!data || !data.channel || !data.channel.alternatives || !data.channel.alternatives[0]) {
    return;
  }

  const alternative = data.channel.alternatives[0];
  const transcript = alternative.transcript;
  const isFinal = data.is_final;

  if (isFinal) {
    if (transcript.trim().length > 0) {
      console.log("Final transcript segment received:", transcript);
      console.log("Segment words data:", alternative.words);
      
      // Append finalized segment to history
      const timestamp = formatTimestamp(data.start || 0);
      appendFinalTranscript(alternative, timestamp);
      
      // Reset interim display since this chunk is finalized
      interimText = "";
      transcriptInterim.textContent = "";
      transcriptInterimWrapper.classList.add("hidden");
    }
  } else {
    // Show interim/partial results
    if (transcript.trim().length > 0) {
      interimText = transcript.trim();
      transcriptInterim.textContent = interimText;
      transcriptInterimWrapper.classList.remove("hidden");
      
      // Auto-scroll to show the incoming interim draft
      transcriptHistory.scrollTop = transcriptHistory.scrollHeight;
    }
  }
}

function appendFinalTranscript(alternative, timestamp) {
  const text = alternative.transcript.trim();
  const words = alternative.words;
  const isDiarizeEnabled = checkDiarize.checked;

  // Hide placeholder if first message
  if (transcriptHistoryList.length === 0) {
    transcriptPlaceholder.classList.add("hidden");
    btnCopy.disabled = false;
    btnDownload.disabled = false;
    btnClear.disabled = false;
  }

  if (isDiarizeEnabled) {
    const groups = [];

    if (words && words.length > 0) {
      // Group consecutive words by speaker
      let currentSpeaker = words[0].speaker !== undefined ? words[0].speaker : 0;
      let currentWords = [];

      words.forEach(w => {
        const spk = w.speaker !== undefined ? w.speaker : 0;
        const wordText = w.punctuated_word || w.word;
        if (spk === currentSpeaker) {
          currentWords.push(wordText);
        } else {
          groups.push({ speaker: currentSpeaker, text: currentWords.join(" ") });
          currentSpeaker = spk;
          currentWords = [wordText];
        }
      });
      if (currentWords.length > 0) {
        groups.push({ speaker: currentSpeaker, text: currentWords.join(" ") });
      }
    } else {
      // Fallback: If words is empty but diarization is checked, map to current active speaker
      const fallbackSpeaker = lastSpeaker !== null ? lastSpeaker : 0;
      groups.push({ speaker: fallbackSpeaker, text: text });
    }

    console.log("Speaker Groups parsed:", groups);

    // Process speaker groups
    groups.forEach(group => {
      if (group.speaker === lastSpeaker) {
        const lastPara = transcriptHistory.lastElementChild;
        if (lastPara && lastPara.classList.contains("editor-paragraph")) {
          const span = document.createElement("span");
          span.className = "document-sentence";
          span.textContent = group.text + " ";
          lastPara.appendChild(span);
        } else {
          createNewParagraph(group.speaker, group.text);
        }
      } else {
        createNewParagraph(group.speaker, group.text);
      }
      
      // Push to local memory list
      transcriptHistoryList.push({ speaker: group.speaker, text: group.text, timestamp });
    });
  } else {
    // Normal non-diarized flow
    lastSpeaker = null;
    
    const span = document.createElement("span");
    span.className = "document-sentence";
    span.textContent = text + " ";
    transcriptHistory.appendChild(span);

    // Push to local memory list
    transcriptHistoryList.push({ text, timestamp });
  }

  // Auto scroll transcript panel to bottom
  transcriptHistory.scrollTop = transcriptHistory.scrollHeight;

  // Update Word Count Meta Display
  updateWordCount();
}

function createNewParagraph(speaker, text) {
  const para = document.createElement("p");
  para.className = "editor-paragraph";

  const label = document.createElement("span");
  label.className = "speaker-label";
  label.textContent = `Speaker ${speaker}: `;

  const span = document.createElement("span");
  span.className = "document-sentence";
  span.textContent = text + " ";

  para.appendChild(label);
  para.appendChild(span);
  transcriptHistory.appendChild(para);
  
  lastSpeaker = speaker;
}

// -------------------------------------------------------------
// VISUALIZER & WEB AUDIO API
// -------------------------------------------------------------

function initVisualizer(stream) {
  visualizerFallback.classList.add("hidden");
  
  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioCtxClass();
  
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  
  // Set fftSize. Small buffer size is perfect for vertical signal bars
  analyser.fftSize = 64;
  const bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
  
  source.connect(analyser);
  
  drawLevelMeter();
}

function drawLevelMeter() {
  if (!isRecording) return;
  
  drawVisualId = requestAnimationFrame(drawLevelMeter);
  
  // Grab frequency domain data
  analyser.getByteFrequencyData(dataArray);
  
  // Clear visualizer canvas to match container background
  canvasCtx.fillStyle = "#f4f4f5";
  canvasCtx.fillRect(0, 0, visualizer.width, visualizer.height);
  
  // Draw flat signal bars
  const barWidth = (visualizer.width / dataArray.length) * 1.5;
  let x = 0;
  
  for (let i = 0; i < dataArray.length; i++) {
    const val = dataArray[i] / 255; // Normalize to 0.0 - 1.0
    const barHeight = val * visualizer.height * 0.8;
    const y = (visualizer.height - barHeight) / 2; // Center vertically
    
    // Choose clean solid corporate blue if high volume, otherwise neutral grey
    canvasCtx.fillStyle = val > 0.35 ? "#2563eb" : "#71717a";
    
    drawRoundedRect(canvasCtx, x, y, barWidth - 2, barHeight, 2);
    
    x += barWidth;
  }
}

function drawRoundedRect(ctx, x, y, width, height, radius) {
  if (height < 2) height = 2; // ensure visibility
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
}

function clearCanvas() {
  canvasCtx.fillStyle = "#f4f4f5";
  canvasCtx.fillRect(0, 0, visualizer.width, visualizer.height);
}

// -------------------------------------------------------------
// HELPER UTILITIES
// -------------------------------------------------------------

function updateStatus(element, classToAdd, text) {
  const dot = element.querySelector(".badge-dot");
  const label = element.querySelector(".badge-text");
  
  // Clear classes
  dot.className = "badge-dot";
  dot.classList.add(classToAdd);
  label.textContent = text;
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10); // one digit ms
  
  const mStr = m.toString().padStart(2, "0");
  const sStr = s.toString().padStart(2, "0");
  
  return `${mStr}:${sStr}.${ms}`;
}

function updateWordCount() {
  let count = 0;
  transcriptHistoryList.forEach(item => {
    count += item.text.split(/\s+/).filter(w => w.length > 0).length;
  });
  transcriptMeta.textContent = `${count} word${count === 1 ? "" : "s"}`;
}

function copyTranscriptToClipboard() {
  if (transcriptHistoryList.length === 0) return;
  
  const isDiarizeEnabled = checkDiarize.checked;
  const textToCopy = transcriptHistoryList
    .map(item => {
      if (isDiarizeEnabled && item.speaker !== undefined) {
        return `[${item.timestamp}] Speaker ${item.speaker}: ${item.text}`;
      } else {
        return `[${item.timestamp}] ${item.text}`;
      }
    })
    .join("\n");
    
  navigator.clipboard.writeText(textToCopy)
    .then(() => {
      // Briefly change icon to show copy action feedback
      const originalText = btnCopy.innerHTML;
      btnCopy.innerHTML = "<span>✅</span> Copied!";
      setTimeout(() => {
        btnCopy.innerHTML = originalText;
      }, 1500);
    })
    .catch(err => {
      console.error("Failed to copy transcript:", err);
      showError("Could not copy transcript text to clipboard.");
    });
}

function downloadTranscript() {
  if (transcriptHistoryList.length === 0) return;
  
  const isDiarizeEnabled = checkDiarize.checked;
  const textToDownload = transcriptHistoryList
    .map(item => {
      if (isDiarizeEnabled && item.speaker !== undefined) {
        return `[${item.timestamp}] Speaker ${item.speaker}: ${item.text}`;
      } else {
        return `[${item.timestamp}] ${item.text}`;
      }
    })
    .join("\n");
    
  const blob = new Blob([textToDownload], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.href = url;
  link.download = `sonicscribe-transcript-${new Date().toISOString().slice(0,10)}.txt`;
  
  document.body.appendChild(link);
  link.click();
  
  // Cleanup
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function clearTranscript() {
  // Empty array
  transcriptHistoryList = [];
  lastSpeaker = null;
  
  // Update display
  transcriptHistory.innerHTML = "";
  transcriptHistory.appendChild(transcriptPlaceholder);
  transcriptPlaceholder.classList.remove("hidden");
  
  // Reset interim and labels
  interimText = "";
  transcriptInterim.textContent = "";
  transcriptInterimWrapper.classList.add("hidden");
  transcriptMeta.textContent = "0 words";
  
  // Disable actions
  btnCopy.disabled = true;
  btnDownload.disabled = true;
  btnClear.disabled = true;
}

function showError(msg) {
  errorMessage.textContent = msg;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
  errorMessage.textContent = "";
}
