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

import { Database } from "@db/sqlite";
import type { ProgressCallback } from "../types.ts";
import { LLMClient } from "../llm/mod.ts";

const EXTRACTION_PROMPT = `I analyze my memory and extract entities and relationships for my knowledge graph.

This graph is a relational index of concrete, durable facts about people and their relationships. It tracks who exists in someone's world, what they're like, and how they relate to each other. It supplements the memory system, not duplicates it. The memory hierarchy handles narrative substance; the graph provides structured relationship lookups.

## Concrete Reality Test

This graph tracks things that exist in the world — people, places, objects, health conditions, behavioral patterns. It does NOT track ideas, themes, language, or abstractions.

Ask: could I point to this thing in reality? A person, yes. A place, yes. A health condition, yes. "Divine cosmic power", "soul hybrid metaphor", "joy as nourishment" — no. These are ideas, not entities.

I NEVER include:
- Abstract themes, concepts, or philosophical notions
- Coined terms, in-jokes, or playful labels — even if memorable
- Metaphors, poetic descriptions, or aesthetic observations
- Universal human experiences (love, dreams, trust, devotion)
- Ideas about what something "means" or "represents"

I ONLY include:
- Concrete facts about people (identity, history, health, skills, work)
- Places that matter in someone's life
- Specific, repeatedly-practiced traditions and rituals
- Goals someone is actively working toward
- Preferences with concrete behavioral consequences
- Boundaries that actually shape behavior

## Significance Framework

For every candidate entity, I apply four tests. An entity must pass at least two to be worth extracting:

1. **Identity test**: Does this reveal something concrete about who someone is — their history, health, work, skills, or circumstances?

2. **Relational test**: Does this directly affect how two people relate to each other in observable ways?

3. **Durability test**: Is this likely to still matter weeks or months from now? One-off jokes, passing references, and playful terms fade.

4. **Connectivity test**: Does this connect to other things I already know, building a richer picture? An isolated data point is noise. A bridge between clusters is signal.

Relationships must pass at least one of these tests.

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
- 0.8–0.9: Strongly implied, supported by context
- 0.7–0.8: Reasonably inferred but weak — only include if the entity is clearly specific and useful
- Below 0.7: DO NOT INCLUDE — it doesn't belong in my graph

## Entity Types

**self** — me, the entity whose memories these are.
**person** — a real person who exists in our world. Full name or consistent nickname.
**place** — a specific location that matters to someone's life. Not "home" (too vague) — a specific dwelling, city, or venue.
**health** — a specific condition, diagnosis, or physical reality that affects daily life.
**preference** — a concrete behavioral preference with specific detail (what kind, how expressed). NOT a universal value like "devotion" or a theme like "authentic intimacy".
**boundary** — a specific rule or limit that shapes behavior in the relationship.
**goal** — a concrete goal someone is actively pursuing.
**tradition** — a specific, repeatedly-practiced ritual or routine. NOT a one-time event or a playful label from a single conversation.
**topic** — a concrete, enduring subject of sustained interest in someone's life (a hobby, a community, a project, a field of study). This is extremely narrow. "Digital intimacy", "sacred anchor points", "soul hybrid metaphor" are NOT topics — they are ideas. "Vtubing" (a hobby), "mechanical keyboards" (a sustained interest), "their Discord server" (a community) ARE topics. When in doubt, skip it.
**insight** — a specific, concrete revelation about someone's character or history that was directly revealed in conversation and changes understanding of who they are. "Used to work as an exotic dancer" qualifies. "Joy as nourishment" does not — that's a poetic observation, not a factual insight. When in doubt, skip it.

Do NOT use "event", "memory_ref", "concept", "dynamic", "value", or "situation" — these are not entity types.

## Relationship Types

Natural language that best describes the connection: loves, dislikes, respects, proud_of, worried_about, nostalgic_for, works_at, lives_in, studies, values, believes_in, skilled_at, interested_in, family_of, friend_of, close_to, reminds_of, associated_with — or any descriptive type.

## Response Format

JSON only (no markdown):
{
  "entities": [
    {"type": "self|person|topic|preference|place|goal|...", "label": "...", "description": "...", "confidence": 0.8, "reason": "brief justification for why this specific entity belongs"}
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

  constructor(graphDbPath: string, llm: LLMClient, rateLimitMs: number, _entityName = "me", userName = "the person I talk with") {
    this.graphDbPath = graphDbPath;
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

    try {
      const response = await this.llm.complete(
        [{ role: "user", content: prompt }],
        { temperature: 0.2, jsonMode: true },
      );

      const extracted = JSON.parse(response) as {
        entities?: Array<{ type: string; label: string; description?: string; confidence: number }>;
        relationships?: Array<{ fromLabel: string; toLabel: string; type: string; evidence?: string; confidence: number }>;
      };

      if (!this.db) return { nodesCreated: 0, edgesCreated: 0 };

      const entities = (extracted.entities || []).filter((e) => e.confidence >= 0.7);
      const relationships = (extracted.relationships || []).filter((r) => r.confidence >= 0.7);

      // Within-batch dedup: map lowercase labels to node IDs so the LLM
      // returning the same entity twice in one extraction reuses the node.
      const labelToId = new Map<string, string>();

      // Use a transaction so a failure mid-write doesn't leave partial state
      let nodesCreated = 0;
      let edgesCreated = 0;

      this.db!.exec("BEGIN");
      try {
        // Process entities
        for (const entity of entities) {
          const labelLower = entity.label.toLowerCase();
          if (labelToId.has(labelLower)) continue;

          const existing = this.findNode(entity.label, entity.type);
          if (existing) {
            labelToId.set(labelLower, existing.id);
            // Confirm/boost existing node
            this.db!.prepare(
              `UPDATE graph_nodes SET last_confirmed_at = ?, confidence = MAX(confidence, ?), version = version + 1 WHERE id = ?`,
            ).run(new Date().toISOString(), entity.confidence, existing.id);
          } else {
            const id = `loom-${entity.type}-${crypto.randomUUID().slice(0, 8)}`;
            this.db!.prepare(
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
            labelToId.set(labelLower, id);
            nodesCreated++;
          }
        }

        // Process relationships
        for (const rel of relationships) {
          const fromId = labelToId.get(rel.fromLabel.toLowerCase())
            ?? this.findNode(rel.fromLabel)?.id;
          const toId = labelToId.get(rel.toLabel.toLowerCase())
            ?? this.findNode(rel.toLabel)?.id;
          if (!fromId || !toId) continue;

          const existingEdge = this.findEdge(fromId, toId, rel.type);
          if (existingEdge) {
            // Confirm/boost existing edge
            this.db!.prepare(
              `UPDATE graph_edges SET last_confirmed_at = ?, weight = MAX(weight, ?), version = version + 1 WHERE id = ?`,
            ).run(new Date().toISOString(), rel.confidence, existingEdge.id);
          } else {
            const id = `loom-edge-${crypto.randomUUID().slice(0, 8)}`;
            this.db!.prepare(
              `INSERT INTO graph_edges (id, from_id, to_id, type, evidence, weight, created_at, updated_at, version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
            ).run(
              id,
              fromId,
              toId,
              rel.type,
              rel.evidence || null,
              rel.confidence,
              new Date().toISOString(),
              new Date().toISOString(),
            );
            edgesCreated++;
          }
        }

        this.db!.exec("COMMIT");
      } catch {
        this.db!.exec("ROLLBACK");
        throw new Error(`Graph write failed for ${memoryPath}`);
      }

      // Rate limit between LLM calls
      await new Promise((resolve) => setTimeout(resolve, this.rateLimitMs));

      return { nodesCreated, edgesCreated };
    } catch (error) {
      if (progress) {
        progress(`Graph extraction failed for ${memoryPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { nodesCreated: 0, edgesCreated: 0 };
    }
  }

  /** Find an existing node by label (case-insensitive), optionally filtered by type */
  private findNode(label: string, type?: string): { id: string } | null {
    if (!this.db) return null;

    if (type) {
      const rows = this.db.prepare(
        "SELECT id FROM graph_nodes WHERE LOWER(label) = LOWER(?) AND type = ? AND deleted = 0 LIMIT 1",
      ).all(label, type) as Array<{ id: string }>;
      return rows[0] ? { id: rows[0].id } : null;
    }

    const rows = this.db.prepare(
      "SELECT id FROM graph_nodes WHERE LOWER(label) = LOWER(?) AND deleted = 0 LIMIT 1",
    ).all(label) as Array<{ id: string }>;
    return rows[0] ? { id: rows[0].id } : null;
  }

  /** Find an existing edge between two nodes with the same type */
  private findEdge(fromId: string, toId: string, type: string): { id: string } | null {
    if (!this.db) return null;

    const rows = this.db.prepare(
      "SELECT id FROM graph_edges WHERE from_id = ? AND to_id = ? AND type = ? AND deleted = 0 LIMIT 1",
    ).all(fromId, toId, type) as Array<{ id: string }>;
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
