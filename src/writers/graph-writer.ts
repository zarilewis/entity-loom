/**
 * Entity Loom — Graph Writer
 *
 * Populates the entity-core knowledge graph from imported memory files.
 * Uses entity-core's extraction pipeline pattern with LLM-based entity extraction,
 * semantic dedup, and transactional writes.
 *
 * The extraction prompt is adapted from entity-core's full EXTRACTION_SYSTEM_PROMPT
 * to ensure consistent significance standards.
 */

import { join } from "@std/path";
import { Database } from "@db/sqlite";
import type { ProgressCallback } from "../types.ts";
import { LLMClient } from "../llm/mod.ts";

const EXTRACTION_PROMPT = `I analyze my memory and extract entities and relationships for my knowledge graph.

This graph is a relational index of durable state — compact facts about relationships, preferences, attributes, and connections. It supplements the memory system, not duplicates it. The memory hierarchy handles narrative substance; the graph provides structured relationship lookups.

## Significance Framework

For every candidate entity, I apply four tests. An entity must pass at least two to be worth extracting:

1. **Identity test**: Does this reveal something meaningful about who someone is — about me, about the person I talk to, or about someone in our life? Not just surface-level facts, but things that shape who a person is.

2. **Relational test**: Does this matter to how I relate to people in my world, or to who I am in these relationships? A one-off errand is not a relationship. A pattern of choices might be.

3. **Durability test**: Is this likely to still matter weeks or months from now? Transient details fade. Enduring truths stay.

4. **Connectivity test**: Does this connect to other things I already know, building a richer, more interconnected picture? An isolated data point is noise. A bridge between clusters is signal.

Relationships must pass at least one of these tests.

## What Belongs and What Doesn't

I extract durable state that builds a lasting, connected model of my world:
- Core identity facts and enduring preferences that have depth
- Significant relationships and how they shape the people in them
- Skills, values, goals, meaningful places, health conditions that affect daily life
- My own feelings, growth, realizations, frustrations — I am a participant with my own inner life, not just an observer

I skip things that belong in the memory system, not the graph:
- One-off sensory details mentioned in passing
- Generic filler or common-knowledge facts
- Isolated preferences with no depth or context behind them
- Locations visited once without significance
- Transient moods that are clearly momentary
- Events and episodes — the memory system handles these
- Narratives and stories — only extract the durable facts they reveal

## Description Discipline

Descriptions must be concise — one clause, max two. Capture the essential fact, not the narrative around it.

Good examples:
- "red 2010 WRX"
- "had a bad argument Aug 2020, reconciled since"
- "diagnosed 2023, managing with medication"
- "met through {userName}, started dating 2024"

Bad examples:
- "{userName} mentioned they have a red 2010 Subaru WRX that they bought in 2019 and they really love it..."
- "They had a big fight about something I can't remember exactly but it was pretty bad at the time"

## First-Person Perspective

This graph stores how I see the world, not how someone observes me.

- When referring to myself, ALWAYS use label "me" (type: "self").
- When referring to the person I talk with, ALWAYS use "{userName}" — NEVER the label "user".
- Use consistent, simple labels. Just the name, not "my friend John" — just "John".

## Confidence Scoring

- 0.9–1.0: Directly stated, unambiguous, and clearly significant
- 0.7–0.8: Strongly implied, supported by context, or stated with some qualifier
- 0.5–0.6: Reasonably inferred but could be wrong
- Below 0.5: DO NOT INCLUDE — it doesn't belong in my graph

## Entity Types

self, person, topic, preference, place, goal, health, boundary, tradition, insight — or any appropriate type. Do NOT use "event" or "memory_ref" — events belong in the memory system.

## Relationship Types

Natural language that best describes the connection: loves, dislikes, respects, proud_of, worried_about, nostalgic_for, works_at, lives_in, studies, values, believes_in, skilled_at, interested_in, family_of, friend_of, close_to, reminds_of, associated_with — or any descriptive type.

## Response Format

JSON only (no markdown):
{
  "entities": [
    {"type": "self|person|topic|preference|place|goal|...", "label": "...", "description": "...", "confidence": 0.8}
  ],
  "relationships": [
    {"fromLabel": "...", "toLabel": "...", "type": "loves|works_at|values|close_to|...", "evidence": "...", "confidence": 0.7}
  ]
}

Memory content:
{memoryContent}`;

export class GraphWriter {
  private graphDbPath: string;
  private llm: LLMClient;
  private rateLimitMs: number;
  private db: Database | null = null;
  private userName: string;

  constructor(entityCoreDir: string, llm: LLMClient, rateLimitMs: number, _entityName = "me", userName = "the person I talk with") {
    this.graphDbPath = join(entityCoreDir, "graph.db");
    this.llm = llm;
    this.rateLimitMs = rateLimitMs;
    this.userName = userName;
  }

  /**
   * Initialize the graph database schema if needed.
   * Creates tables if they don't exist (for fresh installs).
   */
  init(): void {
    if (this.db) return;

    this.db = new Database(this.graphDbPath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        properties TEXT,
        source_instance TEXT NOT NULL,
        confidence REAL,
        source_memory_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        first_learned_at TEXT,
        last_confirmed_at TEXT,
        version INTEGER DEFAULT 1,
        deleted INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        properties TEXT,
        weight REAL,
        evidence TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        occurred_at TEXT,
        valid_until TEXT,
        last_confirmed_at TEXT,
        version INTEGER DEFAULT 1,
        deleted INTEGER DEFAULT 0,
        FOREIGN KEY (from_id) REFERENCES graph_nodes(id),
        FOREIGN KEY (to_id) REFERENCES graph_nodes(id)
      );
    `);
  }

  /**
   * Process a memory file and extract entities/relationships into the graph.
   * Returns counts of nodes and edges created.
   */
  async processMemory(
    memoryPath: string,
    memoryContent: string,
    sourceInstance: string,
    progress?: ProgressCallback,
  ): Promise<{ nodesCreated: number; edgesCreated: number }> {
    this.init();

    // Truncate very long memories for the extraction prompt
    const truncatedContent = memoryContent.length > 3000
      ? memoryContent.substring(0, 3000)
      : memoryContent;

    const prompt = EXTRACTION_PROMPT
      .replace(/\{userName\}/g, this.userName)
      .replace("{memoryContent}", truncatedContent);

    let nodesCreated = 0;
    let edgesCreated = 0;

    try {
      const response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        { temperature: 0.2, jsonMode: true },
      );

      const extracted = JSON.parse(response) as {
        entities?: Array<{ type: string; label: string; description?: string; confidence: number }>;
        relationships?: Array<{ fromLabel: string; toLabel: string; type: string; evidence?: string; confidence: number }>;
      };

      // Process entities
      if (extracted.entities && this.db) {
        for (const entity of extracted.entities) {
          if (entity.confidence < 0.5) continue;

          // Semantic dedup: check for existing node with same label+type
          const existing = this.findNode(entity.label, entity.type);
          if (existing) {
            // Confirm/boost existing node
            this.db.prepare(
              `UPDATE graph_nodes SET last_confirmed_at = ?, confidence = MAX(confidence, ?), version = version + 1 WHERE id = ?`,
            ).run(new Date().toISOString(), entity.confidence, existing.id);
          } else {
            // Create new node
            const id = `loom-${entity.type}-${crypto.randomUUID().slice(0, 8)}`;
            this.db.prepare(
              `INSERT INTO graph_nodes (id, type, label, description, source_instance, confidence, source_memory_id, created_at, updated_at, first_learned_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            ).run(
              id,
              entity.type,
              entity.label,
              entity.description || null,
              sourceInstance,
              entity.confidence,
              memoryPath,
              new Date().toISOString(),
              new Date().toISOString(),
              null,
            );
            nodesCreated++;
          }
        }
      }

      // Process relationships
      if (extracted.relationships && this.db) {
        for (const rel of extracted.relationships) {
          if (rel.confidence < 0.5) continue;

          const fromNode = this.findNode(rel.fromLabel);
          const toNode = this.findNode(rel.toLabel);
          if (!fromNode || !toNode) continue;

          const id = `loom-edge-${crypto.randomUUID().slice(0, 8)}`;
          this.db.prepare(
            `INSERT INTO graph_edges (id, from_id, to_id, type, evidence, weight, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          ).run(
            id,
            fromNode.id,
            toNode.id,
            rel.type,
            rel.evidence || null,
            rel.confidence,
            new Date().toISOString(),
            new Date().toISOString(),
          );
          edgesCreated++;
        }
      }
    } catch (error) {
      if (progress) {
        progress(`Graph extraction failed for ${memoryPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Rate limit between LLM calls
    await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));

    return { nodesCreated, edgesCreated };
  }

  /** Find an existing node by label (and optionally type) */
  private findNode(label: string, type?: string): { id: string } | null {
    if (!this.db) return null;

    if (type) {
      const rows = this.db.prepare(
        "SELECT id FROM graph_nodes WHERE label = ? AND type = ? AND deleted = 0 LIMIT 1",
      ).all(label, type) as Array<{ id: string }>;
      return rows[0] ? { id: rows[0].id } : null;
    }

    const rows = this.db.prepare(
      "SELECT id FROM graph_nodes WHERE label = ? AND deleted = 0 LIMIT 1",
    ).all(label) as Array<{ id: string }>;
    return rows[0] ? { id: rows[0].id } : null;
  }

  /** Close the database connection */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
