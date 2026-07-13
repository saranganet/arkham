import { pipeline } from '@xenova/transformers';

async function testLoader() {
  console.log("=== Testing Speech Emotion Classifier Model Loading ===");
  try {
    console.log("Loading onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX model...");
    const classifier = await pipeline('audio-classification', 'onnx-community/wav2vec2-base-Speech_Emotion_Recognition-ONNX', {
      quantized: true,
      cache_dir: './.cache'
    });
    console.log("✓ Model loaded successfully!");
    
    // Create dummy 16kHz float32 audio data (3 seconds = 48000 samples)
    const dummyAudio = new Float32Array(48000);
    for(let i=0; i<48000; i++) {
      dummyAudio[i] = Math.sin(2 * Math.PI * 440 * i / 16000); // 440Hz sine wave
    }
    
    console.log("Running inference on dummy audio buffer...");
    const result = await classifier(dummyAudio, { sampling_rate: 16000 });
    console.log("✓ Inference result:", JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("✗ Failed to load or run model:", err.message);
  }
}

testLoader();
