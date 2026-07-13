import { queryRAG } from './rag.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const categoriesConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../event-detector/config/categories.json"), "utf8"));

const getCategoryBehavior = (catKey, playbookId) => {
  const config = categoriesConfig[catKey];
  if (!config) return "ai";
  if (config.behavior && typeof config.behavior === "object") {
    return config.behavior[playbookId] || config.behavior.default || "ai";
  }
  return config.behavior || "ai";
};

const getCategoryGuidelineText = (catKey, playbookId) => {
  const config = categoriesConfig[catKey];
  if (!config) return null;
  if (config.guidelineText && typeof config.guidelineText === "object") {
    return config.guidelineText[playbookId] || config.guidelineText.default || null;
  }
  return config.guidelineText || null;
};

async function runTests() {
  console.log("\n=== RUNNING RAG SYSTEM INTEGRATION TESTS ===");

  // Test 1: Direct rule lookup for DEGREE in newtonschool
  console.log("\n[Test 1] Testing Manager Direct Rule Override for 'DEGREE' (newtonschool)");
  const behavior1 = getCategoryBehavior('DEGREE', 'newtonschool');
  const override1 = getCategoryGuidelineText('DEGREE', 'newtonschool');
  console.log("Behavior:", behavior1, "| Result:", override1);
  if (behavior1 === "guideline" && override1 && override1.includes("UGC-recognized")) {
    console.log("✓ Test 1 Passed!");
  } else {
    console.error("✗ Test 1 Failed!");
  }

  // Test 2: Direct rule lookup for FEES in newtonschool (should be null, triggering fallback RAG)
  console.log("\n[Test 2] Testing no Direct Rule for 'FEES' (newtonschool)");
  const behavior2 = getCategoryBehavior('FEES', 'newtonschool');
  const override2 = getCategoryGuidelineText('FEES', 'newtonschool');
  console.log("Behavior:", behavior2, "| Result:", override2);
  if (behavior2 === "ai" && override2 === null) {
    console.log("✓ Test 2 Passed!");
  } else {
    console.error("✗ Test 2 Failed!");
  }

  // Test 3: Semantic search lookup in Qdrant/Mock db for Degree information
  console.log("\n[Test 3] Testing Semantic Search for Degree questions");
  const results3 = await queryRAG("is your CS degree UGC approved?", "newtonschool", 1);
  console.log("Search Results:", JSON.stringify(results3, null, 2));
  if (results3.length > 0 && results3[0].text.includes("UGC")) {
    console.log("✓ Test 3 Passed!");
  } else {
    console.error("✗ Test 3 Failed!");
  }

  // Test 4: Semantic search lookup in Qdrant/Mock db for Fees details
  console.log("\n[Test 4] Testing Semantic Search for pricing objections");
  const results4 = await queryRAG("how much does the course cost and do you have EMI?", "newtonschool", 1);
  console.log("Search Results:", JSON.stringify(results4, null, 2));
  if (results4.length > 0 && results4[0].text.includes("2.25L")) {
    console.log("✓ Test 4 Passed!");
  } else {
    console.error("✗ Test 4 Failed!");
  }

  // Test 5: Semantic search for non-matching queries (should fall below threshold and return empty)
  console.log("\n[Test 5] Testing Search relevance threshold (unrelated query)");
  const results5 = await queryRAG("what is the weather like today?", "newtonschool", 3);
  console.log("Search Results:", JSON.stringify(results5, null, 2));
  if (results5.length === 0) {
    console.log("✓ Test 5 Passed!");
  } else {
    console.error("✗ Test 5 Failed!");
  }

  console.log("\n=== ALL TESTS COMPLETED ===");
}

runTests();
