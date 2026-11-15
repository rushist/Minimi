# Glint: Architecture and design decisions

Glint is a chat agent that uses web search for questions that need current facts or sources. It streams progress while it researches, cites the passages behind its answers, and stores completed turns with timestamps so users can revisit what they asked and when.

## Request flow

1. The React client posts the message and conversation ID to the Hono API. The API streams progress and answer events over server-sent events.
2. The planner considers recent turns, the conversation summary, and the reference date. It can clarify the request or turn it into up to three search specifications with date and domain filters.
3. Research runs searches in parallel, deduplicates and ranks passages, and reads selected pages when snippets are insufficient. Search provider adapters and page extraction sit behind the research pipeline.
4. The answer stage checks claims against the cited passages, flags conflicting evidence, and can return a partial answer or abstain if the evidence is weak.
5. SQLite stores completed turns and supporting evidence. The session cookie scopes access to history. Only public turns are eligible for hosted conversation context.

## Latency and quality

Parallel search, public evidence caching, and selective page reads reduce repeated network calls. Freshness windows vary by subject, and fast-changing or relative-date searches use exact cache keys. Research has limits on rounds, requests, tokens, and time. The agent keeps evidence already gathered if a limit is reached. Progress events show which stage is running before the answer is ready.

Retrieval combines lexical and semantic ranking when local embedding weights are present and falls back to lexical ranking otherwise. Verification checks cited passage IDs and detects obvious numeric mismatches. Citation details expose the supporting text and its publication and retrieval times when available.

## Scope and evaluation

The general research path uses web search as its tool. The current application also has dedicated finance and weather integrations. Those routes call structured data providers, so the full application exceeds a strict web-search-only requirement.

See the [setup and evaluation commands](README.md) and the [replay evaluation report](evals/results.md). Replay uses fixtures and scripted model responses for reproducibility. Its results describe behavior on those cases and do not establish production accuracy or latency.
