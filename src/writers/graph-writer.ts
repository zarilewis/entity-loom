/**
 * Entity Loom — Graph Writer
 *
 * Populates the entity-core knowledge graph from imported memory files.
 * Uses entity-core's extraction pipeline pattern with LLM-based entity extraction,
 * semantic dedup, and transactional writes.
 */

import { join } from "@std/path";
import { Database } from "@db/sqlite";
import type { ProgressCallback } from "../types.ts";
import { LLMClient } from "../llm/mod.ts";

const EXTRACTION_PROMPT = `I analyze my memory and extract entities and relationships for my knowledge graph.

This graph is a relational index of durable state — compact facts about relationships, preferences, attributes, and connections.

## Significance Framework

For every candidate entity, I apply four tests. An entity must pass at least two:
1. Identity test: Reveals something meaningful about who someone is
2. Relational test: Matters to how I relate to people
3. Durability test: Still matters weeks/months from now
4. Connectivity test: Connects to other things I know

Relationships must pass at least one test.

## Entity Types
self, person, topic, preference, place, goal, health, boundary, tradition, insight

## Confidence Scoring
0.9-1.0: Directly stated | 0.7-0.8: Implied | 0.5-0.6: Inferred | Below 0.5: Skip

## Response Format
JSON only (no markdown):
{
  "entities": [
    {"type": "self|person|topic|...", "label": "...", "description": "...", "confidence": 0.8}
  ],
  "relationships": [
    {"fromLabel": "...", "toLabel": "...", "type": "loves|...", "evidence": "...", "confidence": 0.7}
  ]
}

Memory content:
{memoryContent}`;

export class GraphWriter {
  private graphDbPath: string;
  private llm: LLMClient;
  private rateLimitMs: number;
  private db: Database | null = null;

  constructor(entityCoreDir: string, llm: LLMClient, rateLimitMs: number) {
    this.graphDbPath = join(entityCoreDir, "graph.db");
    this.llm = llm;
    this.rateLimitMs = rateLimitMs;
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

    const prompt = EXTRACTION_PROMPT.replace("{memoryContent}", truncatedContent);

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
