<div align="center">

# Narrative

**Your world, curated.** An AI-powered news intelligence platform that aggregates, clusters, and distills global news into a daily briefing — with a built-in analyst you can talk to.

[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![Express](https://img.shields.io/badge/Express-4-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Latest-336791?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4-06b6d4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)

</div>

---

## What is Narrative?

Narrative is a full-stack news intelligence platform. Every day, a fully automated **5-phase pipeline** scours multiple global news APIs, runs articles through AI classifiers, clusters related stories, and surfaces the most important events in a clean, editorial-quality daily brief. Users can dive into any story, browse its full timeline, simplify complex articles, follow topics they care about, and ask an AI analyst questions — all grounded strictly in the source text.

---

## ✨ Features

### 🗞️ Daily Brief
A curated, ranked selection of the day's most significant news — featuring a full-size hero article, a secondary spotlight, and a responsive masonry grid of additional stories. No noise, no filler.

### 🧠 AI-Powered Pipeline
An automated backend pipeline (runnable on a schedule or via CLI) that:
- **Fetches** articles from 4 independent news APIs
- **Filters** by language, length, duplication, and structural quality
- **Classifies** articles via Cerebras LLM (Tier A–D relevance scoring)
- **Enriches** with full-text scraping and vector embeddings (Gemini)
- **Clusters** articles into evolving story threads using cosine similarity
- **Scores** and ranks stories by recency, coverage breadth, and importance
- **Summarizes** each story into bullet-point briefs via LLM

### 📰 Article View & Story Timeline
Click any article to see its full text (or a simplified plain-English version), and a chronological **Story Timeline** — all related articles from the past 14 days, deduplicated by semantic similarity.

### 💬 RAG Chat Assistant
Each article page features a sidebar AI chat powered by Cerebras (`zai-glm-4.7`). Ask any question about the article or its story timeline. The model answers strictly from provided context — no hallucination, no outside knowledge. Chat history is preserved per story in session storage.

### 🔔 Follow Stories
Follow any story cluster to build a personalized **Following** feed — a curated view of all stories you're tracking, with their latest articles and AI-generated summaries.

### 📖 Simplify Mode
Toggle any article between its original form and an AI-simplified, plain-English version — ideal for quickly grasping complex topics.

---

## 🏗️ Architecture

```
Narrative/
├── client/                   # React 19 + Vite + Tailwind CSS frontend
│   └── src/
│       ├── pages/
│       │   ├── HomePage.tsx          # Daily brief (featured + masonry grid)
│       │   ├── ArticleViewPage.tsx   # Article reader + timeline + RAG chat
│       │   └── FollowingPage.tsx     # Personalized following feed
│       ├── components/
│       │   ├── ArticleSidebar.tsx    # RAG chat assistant
│       │   ├── ArticleTimeline.tsx   # Story chronology
│       │   ├── BriefCard.tsx         # Article card (featured/secondary/tertiary)
│       │   ├── SimplifyToggle.tsx    # Original / Simplified toggle
│       │   └── ParsedArticleBody.tsx # Structured article renderer
│       └── api/client.ts             # Typed API client
│
└── server/                   # Node.js + Express + TypeScript backend
    └── src/
        ├── routes/
        │   ├── briefs.ts       # GET /api/briefs/today
        │   ├── articles.ts     # GET /api/articles/:id + simplify
        │   ├── stories.ts      # GET /api/stories/:id/timeline
        │   ├── follows.ts      # POST/DELETE /api/follows/:storyId
        │   ├── chat.ts         # POST /api/chat (RAG endpoint)
        │   └── admin.ts        # POST /api/admin/run-pipeline
        ├── services/
        │   ├── pipeline/       # 5-phase pipeline orchestrator
        │   ├── fetchers/       # WorldNews, TheNewsAPI, Newsdata, Webzio
        │   ├── filters/        # Structural filters + deduplication
        │   ├── llm/            # Cerebras, Gemini, NIM clients
        │   └── stories/        # Clustering, scoring, summarization
        └── db/                 # PostgreSQL schema + migrations
```

---

## 🔄 The Pipeline (5 Phases)

| Phase | Steps | What Happens |
|-------|-------|-------------|
| **1. Ingestion** | F1–F8 | Fetches from 4 APIs → structural filters → global dedup |
| **2. Classification** | C1–C3 | Cerebras LLM scores each article (Tier A/B stored, C/D logged) |
| **3. Enrichment** | E1–E3 | Full-text scraping → Mozilla Readability → Gemini embeddings |
| **4. Story Intelligence** | S1–S6 | Cosine-similarity matching → cluster → dedup → keyword metadata → importance scoring |
| **5. Brief Assembly** | B1–B3 | Select top articles per story → summarize → persist daily brief |

The pipeline can be triggered:
- **Automatically** via `node-cron` on a schedule
- **Manually** via the CLI: `npm run pipeline` in `/server`
- **Via API**: `POST /api/admin/run-pipeline`

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 20+
- **PostgreSQL** 15+ (local or hosted, e.g. Supabase, Neon)
- API keys (see [Environment Variables](#%EF%B8%8F-environment-variables))

### 1. Clone the Repository

```bash
git clone https://github.com/re-fract/Narrative.git
cd Narrative
```

### 2. Install Dependencies

```bash
# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env` in the `/server` directory and fill in your keys:

```bash
cp server/.env.example server/.env
```

### 4. Start Development Servers

```bash
# Terminal 1 — Backend
cd server && npm run dev

# Terminal 2 — Frontend
cd client && npm run dev
```

The frontend will be available at `http://localhost:5173`, proxying API calls to the backend at `http://localhost:3000`.

---

## ⚙️ Environment Variables

Create `server/.env` with the following:

```env
# Server
PORT=3000
FRONTEND_URL=http://localhost:5173

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/narrative

# AI / LLM
GEMINI_API_KEY=          # Google Gemini (embeddings + simplification)
CEREBRAS_API_KEY=        # Cerebras (classification + RAG chat)

# News APIs (one or more required for pipeline)
WORLDNEWS_API_KEY=       # WorldNewsAPI
THENEWSAPI_KEY=          # TheNewsAPI
NEWSDATA_API_KEY=        # Newsdata.io
WEBZIO_API_KEY=          # Webz.io
```

> **Tip:** The app works with just a populated database. You only need all four news API keys to run the full ingestion pipeline.

---

## 🛠️ Available Scripts

### Server (`/server`)

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot-reload (`tsx`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled production build |
| `npm run pipeline` | Manually trigger the full ingestion pipeline |

### Client (`/client`)

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build production bundle |
| `npm run preview` | Preview the production build |
| `npm run lint` | Run ESLint |

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/briefs/today` | Today's curated daily brief |
| `GET` | `/api/articles/:id` | Full article by ID |
| `GET` | `/api/articles/:id/simplify` | AI-simplified version of article |
| `GET` | `/api/stories/:id/timeline` | Chronological story timeline |
| `GET` | `/api/follows` | All followed story IDs |
| `POST` | `/api/follows/:storyId` | Follow a story |
| `DELETE` | `/api/follows/:storyId` | Unfollow a story |
| `POST` | `/api/chat` | RAG chat query (article + timeline context) |
| `POST` | `/api/admin/run-pipeline` | Manually trigger the pipeline |

### Chat Endpoint Payload

```json
{
  "articleId": 123,
  "storyId": 45,
  "question": "What caused this situation?",
  "history": [
    { "role": "user", "content": "Who are the main parties involved?" },
    { "role": "assistant", "content": "According to the articles..." }
  ]
}
```

---

## 🤖 AI Models Used

| Model | Provider | Role |
|-------|----------|------|
| `gpt-oss-120b` / `zai-glm-4.7` | [Cerebras](https://cerebras.ai/) | Article classification, RAG chat |
| `text-embedding-004` | [Google Gemini](https://ai.google.dev/) | Vector embeddings for story clustering |
| Gemini Flash | [Google Gemini](https://ai.google.dev/) | Article simplification & summarization |

---

## 🗄️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript, Tailwind CSS v4, Vite 8 |
| **Routing** | React Router v7 |
| **Backend** | Node.js, Express 4, TypeScript |
| **Database** | PostgreSQL (via `pg`) |
| **AI / LLM** | Cerebras API (OpenAI-compatible), Google Gemini API |
| **Scraping** | Axios + JSDOM + Mozilla Readability |
| **Scheduling** | `node-cron` |
| **Deployment** | Vercel (frontend), any Node.js host (backend) |

---

## 🗺️ Roadmap

- [ ] User authentication and personalized feeds
- [ ] Push notifications for followed stories
- [ ] Export daily brief as PDF / email digest
- [ ] Mobile app (React Native)
- [ ] Multi-language brief support

---

## 🤝 Contributing

Contributions, issues and feature requests are welcome! Feel free to open a PR or file an issue on [GitHub](https://github.com/re-fract/Narrative).

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'feat: add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

<div align="center">

Made with ☕ and way too many news articles.

</div>
