import { pipeline } from '@xenova/transformers';
import { QdrantClient } from '@qdrant/js-client-rest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize embedding pipeline on startup
console.log("Loading local RAG embedding model (Xenova/all-MiniLM-L6-v2)...");
const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  quantized: true,
  cache_dir: './.cache'
});
console.log("✓ RAG embedding model loaded successfully!");

// Setup Qdrant Client or Local Mock Fallback
const qdrantUrl = process.env.QDRANT_URL;
const qdrantApiKey = process.env.QDRANT_API_KEY;
let client = null;
let isMockMode = true;

// Mock database storage
let mockDatabase = [];
const MOCK_STORE_PATH = path.join(__dirname, 'rag_store.json');

// Load mock store from disk if it exists
if (fs.existsSync(MOCK_STORE_PATH)) {
  try {
    mockDatabase = JSON.parse(fs.readFileSync(MOCK_STORE_PATH, 'utf-8'));
    console.log(`Loaded ${mockDatabase.length} chunks from local mock store.`);
  } catch (e) {
    console.warn("Failed to load local mock store, starting empty:", e.message);
  }
}

if (qdrantUrl && qdrantUrl !== "placeholder") {
  try {
    console.log(`Initializing Qdrant Client at URL: ${qdrantUrl}`);
    client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey || undefined
    });
    isMockMode = false;
    
    // Ensure playbooks collection exists
    try {
      const collections = await client.getCollections();
      const exists = collections.collections.some(c => c.name === 'playbooks');
      if (!exists) {
        console.log("Collection 'playbooks' not found in Qdrant. Creating it...");
        await client.createCollection('playbooks', {
          vectors: {
            size: 384, // MiniLM vector size
            distance: 'Cosine'
          }
        });
        console.log("✓ Collection 'playbooks' created successfully.");
      }
    } catch (collErr) {
      console.warn("Failed to check or create collection. Running in Qdrant mode with caution:", collErr.message);
    }
  } catch (err) {
    console.error("✗ Qdrant Client failed to start. Falling back to Local Mock Mode.", err.message);
    isMockMode = true;
  }
} else {
  console.log("QDRANT_URL is not set. Running in Local Mock Vector Mode (using local in-memory cosine search).");
}

// Math helper for Cosine Similarity (used in mock mode)
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Generate UUID for Qdrant points
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Helper to compute text embedding
async function getEmbedding(text) {
  const output = await embedder(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Add a playbook document chunk to the database
 */
export async function addChunk(text, metadata = {}) {
  const embedding = await getEmbedding(text);
  
  if (isMockMode) {
    const record = {
      id: generateUUID(),
      text,
      embedding,
      metadata
    };
    mockDatabase.push(record);
    // Write back to mock store for persistence
    try {
      fs.writeFileSync(MOCK_STORE_PATH, JSON.stringify(mockDatabase, null, 2));
    } catch (e) {
      console.error("Failed to persist mock store:", e.message);
    }
    return record.id;
  } else {
    const id = generateUUID();
    await client.upsert('playbooks', {
      wait: true,
      points: [{
        id,
        vector: embedding,
        payload: {
          text,
          ...metadata
        }
      }]
    });
    return id;
  }
}

/**
 * Query RAG for the most relevant document chunks
 */
export async function queryRAG(queryText, playbook = null, limit = 3) {
  if (!queryText || queryText.trim() === "") return [];
  
  const queryEmbedding = await getEmbedding(queryText);
  const scoreThreshold = 0.40; // Filter out low matching noise

  if (isMockMode) {
    // Filter database by playbook if provided
    let filteredDb = mockDatabase;
    if (playbook) {
      filteredDb = mockDatabase.filter(item => 
        item.metadata && item.metadata.playbook === playbook
      );
    }
    
    // Compute similarities
    const scored = filteredDb.map(item => {
      const score = cosineSimilarity(queryEmbedding, item.embedding);
      return {
        text: item.text,
        score,
        metadata: item.metadata
      };
    });
    
    // Sort and filter by threshold
    return scored
      .filter(item => item.score >= scoreThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } else {
    // Build query filter
    const filter = playbook ? {
      must: [
        {
          key: 'playbook',
          match: { value: playbook }
        }
      ]
    } : undefined;

    const results = await client.search('playbooks', {
      vector: queryEmbedding,
      filter,
      limit,
      with_payload: true
    });

    return results
      .filter(r => r.score >= scoreThreshold)
      .map(r => ({
        text: r.payload.text,
        score: r.score,
        metadata: r.payload
      }));
  }
}



/**
 * Compute semantic similarity between two texts using the local MiniLM model
 */
export async function calculateRelevance(text1, text2) {
  if (!text1 || !text2) return 0;
  try {
    const emb1 = await getEmbedding(text1);
    const emb2 = await getEmbedding(text2);
    return cosineSimilarity(emb1, emb2);
  } catch (err) {
    console.error("[RAG Relevance] Error calculating relevance:", err.message);
    return 0;
  }
}
