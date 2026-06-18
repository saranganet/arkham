import React, { useState, useEffect, useRef } from 'react';

export default function App() {
  // Config States
  const [model, setModel] = useState('nova-3');
  const [language, setLanguage] = useState('en-US');
  const [smartFormat, setSmartFormat] = useState(true);
  const [interimResults, setInterimResults] = useState(true);
  const [diarizationMode, setDiarizationMode] = useState('multichannel'); // 'multichannel' or 'ai'

  // Connection & Recording States
  const [isRecording, setIsRecording] = useState(false);
  const [packetCount, setPacketCount] = useState(0);
  const [status, setStatus] = useState({
    mic: 'ready', // 'ready', 'requested', 'allowed', 'blocked'
    server: 'disconnected', // 'disconnected', 'connecting', 'connected'
    deepgram: 'ready', // 'ready', 'connecting', 'live', 'disconnected'
  });
  const [errorMessage, setErrorMessage] = useState('');

  // Chat & Transcript States
  const [utterances, setUtterances] = useState([]);
  const [interimText, setInterimText] = useState('');
  const [repSpeakerId, setRepSpeakerId] = useState(null);

  // AI Suggestion States
  const [suggestions, setSuggestions] = useState([]);
  const [playbook, setPlaybook] = useState('saas'); // 'saas', 'insurance', 'realestate', 'general'
  const [flashSuggestion, setFlashSuggestion] = useState(false);

  // Refs for Web Audio API & WebSocket
  const socketRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const flashTimeoutRef = useRef(null);
  const audioStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  
  // Auto-scroll refs
  const transcriptEndRef = useRef(null);
  const suggestionsEndRef = useRef(null);

  // Auto-scroll transcript on new items
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [utterances, interimText]);

  // Auto-scroll suggestions
  useEffect(() => {
    if (suggestionsEndRef.current) {
      suggestionsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [suggestions]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecordingSession();
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    };
  }, []);

  // Parser to convert Gemini's THEN-separated text to step checklist array
  const parseSuggestion = (text) => {
    if (!text) return [];
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(line => {
        const upper = line.toUpperCase();
        return upper !== '' && upper !== 'THEN';
      })
      .map(line => {
        // Strip out leading bullet symbols like "•", "-", "*", or numbers
        return line.replace(/^([•\-*\d\.\s])+\s*/, '');
      });
  };

  // -----------------------------------------------------------------
  // RECORDING & WEBSOCKET ACTIONS
  // -----------------------------------------------------------------

  const startRecordingSession = async () => {
    setErrorMessage('');
    setPacketCount(0);
    setUtterances([]);
    setInterimText('');
    setSuggestions([]);
    
    // 1. Get Mic Stream
    setStatus(prev => ({ ...prev, mic: 'requested' }));
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatus(prev => ({ ...prev, mic: 'allowed' }));
    } catch (err) {
      console.error('Mic access denied:', err);
      setStatus(prev => ({ ...prev, mic: 'blocked' }));
      setErrorMessage('Could not access microphone. Ensure permissions are granted.');
      return;
    }

    let activeStream = micStream;
    let displayStream = null;

    if (diarizationMode === 'multichannel') {
      // 2. Get Display/Tab Stream (for Customer's voice)
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        
        // Ensure the display stream actually has audio tracks
        if (displayStream.getAudioTracks().length === 0) {
          displayStream.getTracks().forEach(t => t.stop());
          micStream.getTracks().forEach(t => t.stop());
          setStatus(prev => ({ ...prev, mic: 'ready' }));
          setErrorMessage('You must select a tab or window and check the "Share tab audio" or "Share system audio" box.');
          return;
        }
      } catch (err) {
        console.error('Tab capture denied/canceled:', err);
        micStream.getTracks().forEach(t => t.stop());
        setStatus(prev => ({ ...prev, mic: 'ready' }));
        setErrorMessage('Tab audio capture is required for stereo separation. Allow screen share or switch to AI Diarize.');
        return;
      }

      // 3. Web Audio Mixer (Stereo merge)
      try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioCtxClass();
        audioContextRef.current = audioContext;

        const micSource = audioContext.createMediaStreamSource(micStream);
        const displaySource = audioContext.createMediaStreamSource(displayStream);

        const merger = audioContext.createChannelMerger(2);
        
        // Connect mic (Rep) to Channel 0 (Left)
        micSource.connect(merger, 0, 0);
        // Connect tab (Customer) to Channel 1 (Right)
        displaySource.connect(merger, 0, 1);

        const dest = audioContext.createMediaStreamDestination();
        merger.connect(dest);

        // Mixed stereo stream goes to Deepgram
        activeStream = dest.stream;

        // Auto-identify Sales Rep as Speaker 0 (Channel 0)
        setRepSpeakerId(0);
      } catch (err) {
        console.error('Failed to configure Audio mixer:', err);
        micStream.getTracks().forEach(t => t.stop());
        if (displayStream) displayStream.getTracks().forEach(t => t.stop());
        setStatus(prev => ({ ...prev, mic: 'ready' }));
        setErrorMessage('Audio mixer configuration failed: ' + err.message);
        return;
      }
    } else {
      // AI Diarization: reset rep speaker (manually marked by user)
      setRepSpeakerId(null);
    }

    // Keep stream references
    audioStreamRef.current = activeStream;
    audioStreamRef.current._micStream = micStream;
    audioStreamRef.current._displayStream = displayStream;

    // Handle end-of-sharing event gracefully
    if (displayStream) {
      displayStream.getVideoTracks().forEach(track => {
        track.onended = () => {
          stopRecordingSession();
        };
      });
    }

    setIsRecording(true);
    
    // 4. Initialize visualizer (using local micStream so the rep sees their own voice activity)
    initVisualizer(micStream);

    // 5. Connect to proxy WebSocket
    connectWebSocket();
  };

  const stopRecordingSession = () => {
    setIsRecording(false);

    // Stop Media Recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        console.error(e);
      }
    }
    mediaRecorderRef.current = null;

    // Close Audio Context
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch (e) {
        console.error(e);
      }
    }
    audioContextRef.current = null;

    // Stop all original tracks
    if (audioStreamRef.current) {
      if (audioStreamRef.current._micStream) {
        audioStreamRef.current._micStream.getTracks().forEach(track => track.stop());
      }
      if (audioStreamRef.current._displayStream) {
        audioStreamRef.current._displayStream.getTracks().forEach(track => track.stop());
      }
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }

    // Stop Visualizer Canvas Loop
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    clearCanvas();

    // Close WebSocket
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    // Reset Status Badges
    setStatus({
      mic: 'ready',
      server: 'disconnected',
      deepgram: 'ready'
    });
    setInterimText('');
  };

  const playSuggestionChime = () => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // 880Hz chime
      
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.05); // Volume up in 50ms
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6); // Fade out in 550ms
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch (e) {
      console.warn("Failed to play suggestion chime:", e);
    }
  };

  const connectWebSocket = () => {
    setStatus(prev => ({ ...prev, server: 'connecting' }));
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.port === '5173' ? 'localhost:3000' : window.location.host;
    
    // Determine connection query params
    const isMultichannel = diarizationMode === 'multichannel';
    const wsUrl = `${protocol}//${host}?model=${model}&language=${language}&smart_format=${smartFormat}&interim_results=${interimResults}&diarize=${!isMultichannel}&multichannel=${isMultichannel}&channels=${isMultichannel ? 2 : 1}&playbook=${playbook}`;
    
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      setStatus(prev => ({ ...prev, server: 'connected', deepgram: 'connecting' }));
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        
        switch (payload.type) {
          case 'status':
            if (payload.status === 'connected') {
              setStatus(prev => ({ ...prev, deepgram: 'live' }));
              startAudioCapture();
            }
            break;
          case 'transcript':
            handleDeepgramChunk(payload.data);
            break;
          case 'finalized_utterance':
            setUtterances(prev => [...prev, payload.data]);
            break;
          case 'ai_suggestion':
            const newSteps = parseSuggestion(payload.data.text);
            const suggestionObj = {
              id: Date.now() + Math.random().toString(36).substring(2, 7),
              rawText: payload.data.text,
              steps: newSteps,
              checkedSteps: new Set(),
              timestamp: payload.data.timestamp || Date.now()
            };
            setSuggestions(prev => [...prev, suggestionObj]);
            
            // Option 4: Trigger visual flash and audio chime
            setFlashSuggestion(true);
            playSuggestionChime();
            if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
            flashTimeoutRef.current = setTimeout(() => {
              setFlashSuggestion(false);
            }, 3000);
            break;
          case 'error':
            setErrorMessage(payload.message);
            stopRecordingSession();
            break;
          default:
            break;
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket connection error:', err);
      setErrorMessage('WebSocket connection failed. Ensure backend server is running on port 3000.');
      stopRecordingSession();
    };

    ws.onclose = () => {
      setIsRecording(false);
    };
  };

  const startAudioCapture = () => {
    if (!audioStreamRef.current) return;

    let mimeType = 'audio/webm';
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
      mimeType = 'audio/webm;codecs=opus';
    } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
      mimeType = 'audio/ogg;codecs=opus';
    }

    try {
      const mediaRecorder = new MediaRecorder(audioStreamRef.current, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
          socketRef.current.send(event.data);
          setPacketCount(prev => prev + 1);
        }
      };

      // Slice audio data into 250ms chunks for streaming
      mediaRecorder.start(250);
    } catch (err) {
      console.error('Failed to start media recorder:', err);
      setErrorMessage('Failed to initialize MediaRecorder: ' + err.message);
      stopRecordingSession();
    }
  };

  const handleDeepgramChunk = (data) => {
    if (!data || !data.channel || !data.channel.alternatives || !data.channel.alternatives[0]) {
      return;
    }

    const alternative = data.channel.alternatives[0];
    const transcript = alternative.transcript;
    const isFinal = data.is_final;

    if (isFinal) {
      setInterimText('');
    } else {
      if (transcript.trim().length > 0) {
        setInterimText(transcript.trim());
      }
    }
  };

  const markSpeakerAsRep = (speakerId) => {
    setRepSpeakerId(speakerId);
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'set_rep_speaker', speaker_id: speakerId }));
    }
  };

  // -----------------------------------------------------------------
  // LEVEL METER VISUALIZER
  // -----------------------------------------------------------------

  const initVisualizer = (stream) => {
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioCtxClass();
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 64; // Low FFT size yields a tight, sleek wave bar count
    analyserRef.current = analyser;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    source.connect(analyser);

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      if (!analyserRef.current) return;
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      // Dark background matching modern dashboard
      ctx.fillStyle = '#09090b'; 
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 1.6;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i] / 255;
        const barHeight = val * canvas.height * 0.8;
        const y = (canvas.height - barHeight) / 2; // centered vertically

        // High legibility indigo and purple glow colors
        const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
        gradient.addColorStop(0, '#c084fc'); // Light purple glow
        gradient.addColorStop(1, '#6366f1'); // Electric indigo base

        ctx.fillStyle = val > 0.1 ? gradient : '#27272a'; // dim grey for silent bars
        
        // Draw elegant rounded bars
        drawRoundedRect(ctx, x, y, barWidth - 3, barHeight, 2.5);
        x += barWidth;
      }
    };

    draw();
  };

  const drawRoundedRect = (ctx, x, y, w, h, radius) => {
    const height = h < 3 ? 3 : h; // ensure visibility
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + height - radius);
    ctx.quadraticCurveTo(x + w, y + height, x + w - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  };

  const toggleStepChecked = (suggestionId, stepIndex) => {
    setSuggestions(prev => prev.map(sug => {
      if (sug.id === suggestionId) {
        const newChecked = new Set(sug.checkedSteps);
        if (newChecked.has(stepIndex)) {
          newChecked.delete(stepIndex);
        } else {
          newChecked.add(stepIndex);
        }
        return { ...sug, checkedSteps: newChecked };
      }
      return sug;
    }));
  };

  const downloadTextFile = (content, filename) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadTranscript = () => {
    const lines = utterances.map(u => `[${formatTime(u.start)}] Speaker ${u.speaker}: ${u.text}`);
    downloadTextFile(lines.join('\n'), 'transcript_log.txt');
  };

  const handleDownloadSuggestions = () => {
    const lines = suggestions.map((s, i) => `[AI Suggestion ${i+1}]\n${s.rawText}\n`);
    downloadTextFile(lines.join('\n'), 'ai_suggestions_log.txt');
  };

  // Helper formats
  const formatTime = (timeInSecs) => {
    if (typeof timeInSecs !== 'number') return '0:00';
    const m = Math.floor(timeInSecs / 60);
    const s = Math.floor(timeInSecs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      {/* Sleek top header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-pulse"></div>
          <span className="brand-logo">CLUELY</span>
          <span className="brand-sub">COPILOT</span>
        </div>

        <div className="hud-status">
          <div className={`status-badge mic-${status.mic}`}>
            <span className="badge-pulse"></span>
            Mic: {status.mic.toUpperCase()}
          </div>
          <div className={`status-badge server-${status.server}`}>
            <span className="badge-pulse"></span>
            Proxy: {status.server.toUpperCase()}
          </div>
          <div className={`status-badge dg-${status.deepgram}`}>
            <span className="badge-pulse"></span>
            Deepgram: {status.deepgram.toUpperCase()}
          </div>
          <div className="status-badge packet-badge">
            Chunks: {packetCount}
          </div>
        </div>
      </header>

      {/* Primary Workspace Layout */}
      <div className="workspace-layout">
        {/* Left Side: Call Controls Panel */}
        <aside className="control-sidebar">
          <div className="sidebar-card section-controls">
            <h2>Call Configuration</h2>
            
            <div className="input-group">
              <label>Acoustic Model</label>
              <select 
                value={model} 
                onChange={(e) => setModel(e.target.value)}
                disabled={isRecording}
              >
                <option value="nova-3">Nova-3 (Ultra Latency)</option>
                <option value="nova-2">Nova-2 (Stable)</option>
                <option value="enhanced">Enhanced (Universal)</option>
              </select>
            </div>

            <div className="input-group">
              <label>Language</label>
              <select 
                value={language} 
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isRecording}
              >
                <option value="en-US">English (US)</option>
                <option value="en-GB">English (UK)</option>
                <option value="multi">Multilingual (Auto Detect)</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="hi">Hindi</option>
              </select>
            </div>

            <div className="checkbox-group">
              <label className="custom-checkbox">
                <input 
                  type="checkbox" 
                  checked={smartFormat} 
                  onChange={(e) => setSmartFormat(e.target.checked)}
                  disabled={isRecording}
                />
                <span className="checkbox-indicator"></span>
                Smart Punctuation
              </label>

              <label className="custom-checkbox">
                <input 
                  type="checkbox" 
                  checked={interimResults} 
                  onChange={(e) => setInterimResults(e.target.checked)}
                  disabled={isRecording}
                />
                <span className="checkbox-indicator"></span>
                Real-Time Drafts
              </label>
            </div>

            <div className="input-group" style={{ marginTop: '16px' }}>
              <label>Diarization Mode</label>
              <select 
                value={diarizationMode} 
                onChange={(e) => setDiarizationMode(e.target.value)}
                disabled={isRecording}
              >
                <option value="multichannel">Hardware Stereo (Mic + Tab Audio)</option>
                <option value="ai">Single-Mic AI Diarize</option>
              </select>
            </div>

            <div className="input-group" style={{ marginTop: '16px' }}>
              <label>Sales Playbook</label>
              <select 
                value={playbook} 
                onChange={(e) => setPlaybook(e.target.value)}
                disabled={isRecording}
              >
                <option value="saas">B2B SaaS & Tech</option>
                <option value="insurance">B2C Insurance Sales</option>
                <option value="realestate">Real Estate & Property</option>
                <option value="general">General B2C/B2B Sales</option>
              </select>
            </div>
          </div>

          {/* Canvas Wave Visualizer & Recording Controls */}
          <div className="sidebar-card section-activation">
            <div className="visualizer-wrapper">
              <canvas ref={canvasRef} width="260" height="40" className="canvas-level" />
              {!isRecording && <div className="visualizer-overlay">Audio Stream Off</div>}
            </div>

            {errorMessage && (
              <div className="error-banner">
                <span className="error-icon">⚠️</span>
                <span className="error-text">{errorMessage}</span>
              </div>
            )}

            {!isRecording ? (
              <button className="btn-trigger btn-start" onClick={startRecordingSession}>
                <span className="btn-icon">🎙️</span> Start Copilot Session
              </button>
            ) : (
              <button className="btn-trigger btn-stop" onClick={stopRecordingSession}>
                <span className="btn-icon-stop">■</span> Stop Recording
              </button>
            )}
          </div>

          <div className="sidebar-card helper-guide">
            <h3>Diarization Roles</h3>
            <p>Once speech is captured, click the <strong>"Mark as Rep"</strong> button on your speech bubbles to assign roles. This helps the AI isolate customer speech and deliver targeted coaching advice.</p>
          </div>
        </aside>

        {/* Center: Live Transcript Stream Feed */}
        <main className="transcript-panel">
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <h2>Live Conversation Feed</h2>
              <div className="role-legend">
                <span className="legend-rep">Rep (Right)</span>
                <span className="legend-cust">Customer (Left)</span>
              </div>
            </div>
            <button className="btn-secondary" onClick={handleDownloadTranscript} style={{ height: 'fit-content', alignSelf: 'center', padding: '6px 12px', fontSize: '12px' }}>⬇ Download Log</button>
          </div>

          <div className="transcript-feed-scroll">
            {utterances.length === 0 && !interimText && (
              <div className="transcript-empty-state">
                <div className="empty-state-bubble">🗣️</div>
                <p>Waiting for speech input...</p>
                <span className="empty-state-sub">Activate the copilot and begin speaking. Your diarized transcript blocks will populate here.</span>
              </div>
            )}

            {utterances.map((utt) => {
              const isRep = repSpeakerId !== null ? utt.speaker === repSpeakerId : false;
              const speakerName = isRep ? 'You (Rep)' : 'Customer';
              
              return (
                <div 
                  key={utt.id} 
                  className={`utterance-card-row ${isRep ? 'align-rep' : 'align-customer'}`}
                >
                  <div className={`utterance-card ${isRep ? 'theme-rep' : 'theme-customer'}`}>
                    <div className="utt-meta">
                      <span className="utt-speaker-label">{speakerName}</span>
                      
                      {repSpeakerId === null && (
                        <button 
                          className="btn-mark-rep-badge"
                          onClick={() => markSpeakerAsRep(utt.speaker)}
                        >
                          Mark as Rep
                        </button>
                      )}
                      
                      <span className="utt-timestamp">{formatTime(utt.start)}</span>
                    </div>
                    <p className="utt-text-content">{utt.text}</p>
                  </div>
                </div>
              );
            })}

            {/* Interim live text draft bubble */}
            {interimText && (
              <div className="utterance-card-row align-customer drafting">
                <div className="utterance-card theme-interim">
                  <div className="utt-meta">
                    <span className="utt-speaker-label">Drafting...</span>
                    <span className="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </span>
                  </div>
                  <p className="utt-text-content">{interimText}</p>
                </div>
              </div>
            )}
            
            <div ref={transcriptEndRef} />
          </div>
        </main>

        {/* Right Side: Cluely Sales Copilot HUD */}
        <section className={`copilot-hud-panel ${flashSuggestion ? 'suggestions-flash-active' : ''}`}>
          <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <div>
              <h2>Sales Copilot HUD</h2>
              <span className="hud-subtitle">PAS/EVC Tactical Guidance</span>
            </div>
            <button className="btn-secondary" onClick={handleDownloadSuggestions} style={{ height: 'fit-content', alignSelf: 'center', padding: '6px 12px', fontSize: '12px' }}>⬇ Download Log</button>
          </div>

          <div className="hud-suggestions-scroll">
            {suggestions.length === 0 ? (
              <div className="hud-empty-state">
                <div className="radar-icon-wrapper">
                  <div className="radar-pulse ring-1"></div>
                  <div className="radar-pulse ring-2"></div>
                  <div className="radar-pulse ring-3"></div>
                  <div className="radar-core">💡</div>
                </div>
                <p>Monitoring conversation...</p>
                <span className="hud-empty-sub">Gemini will inject real-time negotiation tactics and objection cues here based on customer speech.</span>
              </div>
            ) : (
              <div className="suggestions-list">
                {suggestions.map((sug) => (
                  <div key={sug.id} className="suggestion-card">
                    <div className="sug-header">
                      <div className="sug-label-section">
                        <span className="sug-tag-icon">⚡</span>
                        <span className="sug-title">TACTICAL CUES</span>
                      </div>
                      <span className="sug-time">
                        {new Date(sug.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    </div>

                    <div className="sug-stepper">
                      {sug.steps.map((step, idx) => {
                        const isChecked = sug.checkedSteps.has(idx);
                        
                        // Check for multi-style phrasings (Soft vs Bold)
                        const multiPhraseMatch = step.match(/^(.*?)\s*\(Soft:\s*["']?(.*?)["']?\s*\|\s*Bold:\s*["']?(.*?)["']?\)$/i);
                        
                        let directionText = step;
                        let suggestedPhrase = null;
                        let softPhrase = null;
                        let boldPhrase = null;

                        if (multiPhraseMatch) {
                          directionText = multiPhraseMatch[1];
                          softPhrase = multiPhraseMatch[2];
                          boldPhrase = multiPhraseMatch[3];
                        } else {
                          const singlePhraseMatch = step.match(/^(.*?)\s*\(Say:\s*["']?(.*?)["']?\)$/i) || 
                                                    step.match(/^(.*?)\s*Say:\s*["']?(.*?)["']?$/i);
                          if (singlePhraseMatch) {
                            directionText = singlePhraseMatch[1];
                            suggestedPhrase = singlePhraseMatch[2];
                          }
                        }

                        return (
                          <div 
                            key={idx} 
                            className={`stepper-item ${isChecked ? 'step-completed' : ''}`}
                            onClick={() => toggleStepChecked(sug.id, idx)}
                          >
                            <div className="stepper-checkbox-wrapper">
                              <div className="stepper-checkbox">
                                {isChecked && <span className="checkmark-tick">✓</span>}
                              </div>
                              {idx < sug.steps.length - 1 && <div className="stepper-connector-line"></div>}
                            </div>
                            
                            <div className="stepper-content">
                              <span className="step-number">STEP {idx + 1}</span>
                              <p className="step-instruction">{directionText}</p>
                              {suggestedPhrase && (
                                <div className="step-phrase-bubble">
                                  <span className="step-phrase-quote">“</span>
                                  {suggestedPhrase}
                                  <span className="step-phrase-quote">”</span>
                                </div>
                              )}
                              {softPhrase && boldPhrase && (
                                <div className="step-multiphrase-container">
                                  <div className="multiphrase-bubble soft-bubble">
                                    <span className="phrase-badge soft-badge">Soft</span>
                                    <span className="step-phrase-quote">“</span>
                                    {softPhrase}
                                    <span className="step-phrase-quote">”</span>
                                  </div>
                                  <div className="multiphrase-bubble bold-bubble">
                                    <span className="phrase-badge bold-badge">Bold</span>
                                    <span className="step-phrase-quote">“</span>
                                    {boldPhrase}
                                    <span className="step-phrase-quote">”</span>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div ref={suggestionsEndRef} />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
