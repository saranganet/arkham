# Playbook & RAG Ingestion Pipeline Architecture

This document specifies the technical design for a future administrative ingestion system. The system divides playbook uploads into a **Checklist/Guideline Extractor** (Pipeline 1) and a **Factual RAG Ingester** (Pipeline 2).

---

## Architecture Overview

Admin managers require a simple, drag-and-drop system to upload playbooks. The system splits ingestion into two distinct lanes:

```mermaid
flowchart TD
    DragDrop[Admin Drag-and-Drops Documents] --> Router{Uploader Mode?}
    
    Router -->|Checklist & Script| P1[Pipeline 1: Checklist & Guideline Extractor]
    Router -->|Factual Knowledge Docs| P2[Pipeline 2: Factual RAG Ingester]
    
    subgraph Pipeline 1: Checklist Extraction
        P1 --> P1_Parse[PDF/TXT Text Extraction]
        P1_Parse --> P1_LLM[Ingestion LLM Agent]
        
        P1_LLM -->|Extract Flow| P1_UI[Generate Call Checklist Draft]
        P1_LLM -->|Extract Rules| P1_Overrides[Map Category Guidelines]
        
        P1_UI --> P1_Review[Manager Review & Approve Gate]
        P1_Review --> P1_Playbook[Write to playbooks.json]
        P1_Overrides --> P1_Config[Write guidelines to categories.json]
    end

    subgraph Pipeline 2: RAG Ingestion
        P2 --> P2_Chunk[Overlap Text Slicer]
        P2_Chunk --> P2_Embed[MiniLM Vectorizer]
        P2_Embed --> P2_Qdrant[Write directly to Qdrant/Mock Vector DB]
    end
```

---

## 1. Pipeline 1: Checklist & Guideline Extractor

### A. Automatic Ingestion & Decomposition
When an administrative manager uploads a core sales training manual or script (e.g. `Sales Training (1).txt`):
1.  **File Parsing:** Extractor pulls plain text from PDF, DOCX, or TXT.
2.  **Decomposition Agent:** A large-context LLM (e.g. Gemini 1.5 Pro) reads the text alongside our existing categories schema (`categories.json`) and outputs a structured JSON payload:
    *   `checklist_steps`: A sequential list containing a title, description, and key phrase triggers (e.g., *"Probing Education Background"*).
    *   `category_guidelines`: Playbook-specific guidelines mapped directly to category keys (e.g., mapping Simplilearn comparisons to `COMPETITOR`).
    *   `new_categories`: Suggested categories discovered in the playbook that are missing from our system.

### B. The Manager Approval Gate (UI Checklist Editor)
Rather than writing directly to system config files:
1.  The UI renders the parsed checklist in an interactive **Checklist Editor** interface.
2.  The manager reviews the steps, edits titles, shifts sequence, adds/removes items, and approves guidelines mapping.
3.  Upon approval, the system commits the updates:
    *   Checklist steps are added to the playbook entry in `playbooks.json`.
    *   Guidelines are written to `categories.json` and `keyword_bypasses.json`.

### C. Browser-to-Server Call Progress Alignment
To ensure LLM 2 understands the current checklist stage without bloating prompts with the full checklist text:
1.  The browser's local MiniLM model tracks the Sales Rep's transcript. When a stage-trigger matches, it ticks off the step in the progress bar.
2.  When sending utterances over the WebSocket, the client app appends the active checklist step name:
    ```json
    { "type": "speech_frame", "text": "...", "activeChecklistStep": "Probing: Education Qualification" }
    ```
3.  The STT Proxy server injects this metadata as a single line at the top of the LLM 2 user prompt:
    `[CURRENT CALL STAGE]: Step 4 of 20 - Probing: Education Qualification`
    This aligns the suggestion model with the conversational stage at a cost of near-zero tokens.

---

## 2. Pipeline 2: Factual RAG Ingester

For uploading raw company fact sheets, security compliance guides, pricing matrices, or product spec sheets:
1.  **Direct Ingestion:** The document is uploaded directly to the RAG processing pipeline.
2.  **Text Slicing:** A document splitter cuts the text into semantic, overlapping chunks (e.g., 500-character chunks with a 100-character overlap) to preserve local context.
3.  **Vector Embedding:** Chunks are vectorized using the RAG model (e.g., `all-MiniLM-L6-v2`).
4.  **Vector Store Commit:** Embeddings are written directly into the Vector Database (Qdrant) under the corresponding `playbook` collection partition. No guidelines or checklists are modified.

---

## 3. Implementation Phasing Strategy

*   **Phase 1 (Current):** Finish UI tasks (Topic-Tagged Badges, Option B whole-card check-off cascades).
*   **Phase 2 (Next):** Implement the Call Progress Checklist HUD component and seed current playbook objections into config guidelines.
*   **Phase 3 (Future):** Build Pipelines 1 and 2 with administrative uploader UI controls.
