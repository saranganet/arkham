async function testFetchBert() {
  console.log("Checking direct fetch to Hugging Face for BERT...");
  try {
    const res = await fetch("https://huggingface.co/Xenova/bert-base-uncased/resolve/main/config.json");
    console.log("Response status:", res.status);
    const text = await res.text();
    console.log("Response text (partial):", text.slice(0, 200));
  } catch (err) {
    console.error("Fetch failed:", err.message);
  }
}

testFetchBert();
