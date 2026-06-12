# Arkham Monorepo

Welcome to the **Arkham** project ecosystem. This repository is structured as a monorepo workspace to support modular growth as we introduce different services and client modules.

## Architecture

* **`services/`**: Holds backend microservices and API gateways.
  * **[stt-proxy/](file:///Users/sohamsaranga/Desktop/stt/services/stt-proxy)**: Express + WebSocket gateway proxying real-time browser audio recording streams to Deepgram's live transcription API.
* **`packages/`**: Reserved for shared configuration packages, helper utilities, schemas, and frontends.

---

## Installation & Setup

1. **Install Dependencies**: Run `npm install` at the root. This will automatically resolve and install dependencies across all workspaces:
   ```bash
   npm install
   ```

2. **Configure Environment variables**: Create a `.env` file under `services/stt-proxy/.env` (a template is available in `.env.example`) and configure your credentials:
   ```env
   PORT=3001
   DEEPGRAM_API_KEY=your_deepgram_api_key
   ```

3. **Run Services**:
   * To start the Speech-to-Text proxy service locally:
     ```bash
     npm run stt:start
     ```
   * To start in watch/development mode:
     ```bash
     npm run stt:dev
     ```
