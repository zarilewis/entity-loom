/**
 * Entity Loom — Command Handlers
 *
 * Implements the import, resume, and configure CLI commands.
 */

import { join } from "@std/path";
import type { PipelineConfig, PlatformType } from "../types.ts";
import { buildConfig, validateConfig, getLLMConfig } from "../config.ts";
import { ProgressReporter } from "./progress.ts";
import { askString, askChoice, askConfirm, askMultiline } from "./prompts.ts";
import { detectPlatform, getRegisteredPlatforms } from "../parsers/mod.ts";
import { CheckpointManager } from "../dedup/checkpoint.ts";
import { runPipeline } from "../pipeline/orchestrator.ts";
import { LLMClient } from "../llm/mod.ts";

/**
 * Interactive import command — guides user through the full pipeline.
 */
export async function importCommand(flags: Record<string, string | boolean>): Promise<void> {
  const progress = new ProgressReporter("[entity-loom]");
  const partial = buildConfig(flags);

  // Step 1: Platform
  let platform = partial.platform;
  if (!platform) {
    const options = getRegisteredPlatforms().map((p) => ({
      label: p.charAt(0).toUpperCase() + p.slice(1),
      value: p,
    }));
    platform = await askChoice("Which platform are you importing from?", options) as PlatformType;
  }

  // Step 2: Input path
  let inputPath = partial.inputPath;
  if (!inputPath) {
    inputPath = await askString("Path to export file or directory");
  }

  // Validate input exists
  try {
    await Deno.stat(inputPath);
  } catch {
    progress.error(`File not found: ${inputPath}`);
    Deno.exit(1);
  }

  // Auto-detect platform if not specified
  if (!platform) {
    const detected = await detectPlatform(inputPath);
    if (detected) {
      platform = detected;
      progress.log(`Detected platform: ${platform}`);
    } else {
      platform = await askChoice(
        "Could not detect platform. Which platform?",
        getRegisteredPlatforms().map((p) => ({
          label: p.charAt(0).toUpperCase() + p.slice(1),
          value: p,
        })),
      ) as PlatformType;
    }
  }

  // Step 3: Entity name
  let entityName = partial.entityName;
  if (!entityName) {
    entityName = await askString("What name should the entity be called in memories?");
  }

  // Step 4: Entity pronouns
  let entityPronouns = partial.entityPronouns;
  if (!entityPronouns) {
    entityPronouns = await askString("What pronouns does the entity use? (e.g., she/her)");
    if (!entityPronouns) entityPronouns = undefined;
  }

  // Step 5: User name
  let userName = partial.userName;
  if (!userName) {
    userName = await askString("What is your name (for memory writing)?");
  }

  // Step 6: User pronouns
  let userPronouns = partial.userPronouns;
  if (!userPronouns) {
    userPronouns = await askString("What pronouns do you use? (e.g., he/him)");
    if (!userPronouns) userPronouns = undefined;
  }

  // Step 7: Relationship context
  let relationshipContext = partial.relationshipContext;
  if (!relationshipContext) {
    relationshipContext = await askString("What is your relationship to the entity? (e.g., partner, close friend)");
    if (!relationshipContext) relationshipContext = undefined;
  }

  // Step 8: Context notes
  let contextNotes = partial.contextNotes || "";
  if (!contextNotes && !partial.contextNotes) {
    contextNotes = await askMultiline(
      "Any context about the conversation history? (persona names, life events, etc.)\n" +
      "This helps the memory writer understand things it can't infer from messages alone.",
    );
  }

  // Step 9: Output directory
  const outputDir = partial.outputDir || join(Deno.cwd(), ".loom-exports");

  // Build config
  const config: PipelineConfig = {
    platform: platform!,
    inputPath,
    outputDir,
    entityName,
    userName,
    contextNotes,
    instanceId: (partial.instanceId as string) || platform!,
    workerModel: partial.workerModel || "",
    maxContextTokens: partial.maxContextTokens || 90000,
    rateLimitMs: partial.rateLimitMs || 2000,
    requestTimeoutMs: partial.requestTimeoutMs || 120000,
    dryRun: partial.dryRun || false,
    skipGraph: partial.skipGraph || false,
    skipMemories: partial.skipMemories || false,
    significanceThreshold: partial.significanceThreshold || 0.7,
    costEstimate: partial.costEstimate || false,
    dateFrom: partial.dateFrom,
    dateTo: partial.dateTo,
    idPrefix: partial.idPrefix,
    entityPronouns,
    userPronouns,
    relationshipContext,
  };

  // Validate
  const errors = validateConfig(config);
  if (errors.length > 0) {
    progress.error("Configuration errors:");
    for (const err of errors) {
      progress.error(`  - ${err}`);
    }
    Deno.exit(1);
  }

  // Validate LLM config (support CLI overrides)
  const llmOverrides = {
    apiKey: typeof flags["api-key"] === "string" ? flags["api-key"] : undefined,
    baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
    model: typeof flags.model === "string" ? flags.model : undefined,
  };
  const llmConfig = getLLMConfig(llmOverrides);
  if (!llmConfig.apiKey && !config.dryRun) {
    progress.error("LLM_API_KEY not set in environment. Memory generation requires an LLM API key.");
    progress.error("Set it in .env or as an environment variable, or use --api-key.");
    Deno.exit(1);
  }

  // Summary
  console.log("\n--- Import Summary ---");
  console.log(`  Platform:      ${config.platform}`);
  console.log(`  Input:         ${config.inputPath}`);
  console.log(`  Entity name:   ${config.entityName}${config.entityPronouns ? ` (${config.entityPronouns})` : ""}`);
  console.log(`  User name:     ${config.userName}${config.userPronouns ? ` (${config.userPronouns})` : ""}`);
  if (config.relationshipContext) console.log(`  Relationship:  ${config.relationshipContext}`);
  console.log(`  Instance:      ${config.instanceId}`);
  console.log(`  Output:        ${config.outputDir}/${config.entityName}-${config.platform}/`);
  if (config.dryRun) console.log(`  Mode:          DRY RUN (no writes)`);
  if (config.skipMemories) console.log(`  Memories:      SKIPPED`);
  if (config.skipGraph) console.log(`  Graph:         SKIPPED`);
  console.log("");

  const proceed = await askConfirm("Proceed with import?", true);
  if (!proceed) {
    progress.log("Import cancelled.");
    Deno.exit(0);
  }

  // Run pipeline
  try {
    const result = await runPipeline(config, (msg) => progress.log(msg));

    console.log("\n--- Results ---");
    progress.summary({
      "Conversations parsed": result.pass1.conversationsParsed,
      "Conversations skipped": result.pass1.conversationsSkipped,
      "Conversations stored": result.pass2.conversationsStored,
      "Messages stored": result.pass2.messagesStored,
      "Daily memories": result.pass3a.dailyMemoriesCreated,
      "Significant memories": result.pass3b.significantMemoriesCreated,
      "Graph nodes": result.pass4.nodesCreated,
      "Graph edges": result.pass4.edgesCreated,
    });

    console.log("\nImport complete!");
    Deno.exit(0);
  } catch (error) {
    progress.error(`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`);
    progress.log("Use 'entity-loom resume' to continue from the last checkpoint.");
    Deno.exit(2);
  }
}

/**
 * Resume a partially-completed import.
 */
export async function resume(flags: Record<string, string | boolean>): Promise<void> {
  const progress = new ProgressReporter("[entity-loom]");
  const partial = buildConfig(flags);

  const outputDir = partial.outputDir || join(Deno.cwd(), ".loom-exports");

  // Find package directories with checkpoints
  let packageDir: string | null = null;

  try {
    for await (const entry of Deno.readDir(outputDir)) {
      if (!entry.isDirectory) continue;
      const candidate = join(outputDir, entry.name, "checkpoint.json");
      try {
        await Deno.stat(candidate);
        packageDir = join(outputDir, entry.name);
        break;
      } catch {
        // no checkpoint in this directory
      }
    }
  } catch {
    // outputDir doesn't exist yet
  }

  if (!packageDir) {
    progress.error("No checkpoint found. Run 'entity-loom import' to start a new import.");
    Deno.exit(1);
  }

  const checkpointMgr = new CheckpointManager(packageDir);
  const checkpoint = await checkpointMgr.load();

  if (!checkpoint) {
    progress.error("No checkpoint found. Run 'entity-loom import' to start a new import.");
    Deno.exit(1);
  }

  progress.log(`Resuming import from: ${packageDir}`);
  progress.log(`Started ${checkpoint.startedAt}`);
  console.log(`  Platform: ${checkpoint.platform}`);
  console.log(`  Entity: ${checkpoint.entityName}`);
  console.log(`  User: ${checkpoint.userName}`);
  console.log(`  Pass 1 (Parse):    ${checkpoint.pass1.completed ? "complete" : "incomplete"}`);
  console.log(`  Pass 2 (Store):    ${checkpoint.pass2.completed ? "complete" : "incomplete"}`);
  console.log(`  Pass 3a (Daily):   ${checkpoint.pass3a.completed ? "complete" : `incomplete (${checkpoint.pass3a.failedDates.length} failed dates)`}`);
  console.log(`  Pass 3b (Signif.): ${checkpoint.pass3b.completed ? "complete" : `incomplete (${checkpoint.pass3b.failedConversationIds.length} failed convos)`}`);
  console.log(`  Pass 4 (Graph):    ${checkpoint.pass4.completed ? "complete" : "incomplete"}`);
  console.log(`  Pass 5 (Package):  ${checkpoint.pass5.completed ? "complete" : "incomplete"}`);
  console.log("");

  const config: PipelineConfig = {
    platform: checkpoint.platform,
    inputPath: checkpoint.inputPath,
    outputDir,
    entityName: checkpoint.entityName,
    userName: checkpoint.userName,
    contextNotes: checkpoint.contextNotes,
    instanceId: checkpoint.instanceId,
    workerModel: partial.workerModel || "",
    maxContextTokens: partial.maxContextTokens || 90000,
    rateLimitMs: partial.rateLimitMs || 2000,
    requestTimeoutMs: partial.requestTimeoutMs || 120000,
    dryRun: false,
    skipGraph: partial.skipGraph || false,
    skipMemories: partial.skipMemories || false,
    significanceThreshold: partial.significanceThreshold || 0.7,
    costEstimate: partial.costEstimate || false,
    dateFrom: partial.dateFrom,
    dateTo: partial.dateTo,
    idPrefix: partial.idPrefix,
    entityPronouns: partial.entityPronouns,
    userPronouns: partial.userPronouns,
    relationshipContext: partial.relationshipContext,
  };

  try {
    const result = await runPipeline(config, (msg) => progress.log(msg));

    console.log("\n--- Results ---");
    progress.summary({
      "Conversations parsed": result.pass1.conversationsParsed,
      "Conversations skipped": result.pass1.conversationsSkipped,
      "Conversations stored": result.pass2.conversationsStored,
      "Messages stored": result.pass2.messagesStored,
      "Daily memories": result.pass3a.dailyMemoriesCreated,
      "Significant memories": result.pass3b.significantMemoriesCreated,
      "Graph nodes": result.pass4.nodesCreated,
      "Graph edges": result.pass4.edgesCreated,
    });

    Deno.exit(0);
  } catch (error) {
    progress.error(`Resume failed: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(2);
  }
}

/**
 * Interactive LLM configuration command.
 * Walks through API key, base URL, model selection, and connection test.
 */
export async function configure(_flags: Record<string, string | boolean>): Promise<void> {

  // Read current .env values
  const currentKey = Deno.env.get("LLM_API_KEY") || "";
  const currentUrl = Deno.env.get("LLM_BASE_URL") || "https://openrouter.ai/api/v1";
  const currentModel = Deno.env.get("LLM_MODEL") || "google/gemini-2.5-flash";
  const currentWorker = Deno.env.get("WORKER_MODEL") || "";

  console.log("\n--- LLM Configuration ---\n");

  // API Key
  console.log(`Current API key: ${currentKey ? currentKey.substring(0, 8) + "..." + currentKey.slice(-4) : "(not set)"}`);
  const newKey = await askString("Enter new API key (or press Enter to keep current)");
  const apiKey = newKey || currentKey;

  // Base URL with presets
  console.log("\nSelect API provider:");
  const providerOptions = [
    { label: "OpenRouter", value: "https://openrouter.ai/api/v1" },
    { label: "Z.ai", value: "https://api.z.ai/api/coding/paas/v4" },
    { label: "OpenAI", value: "https://api.openai.com/v1" },
    { label: "Anthropic", value: "https://api.anthropic.com/v1" },
    { label: "Custom URL", value: "custom" },
    { label: `Keep current (${currentUrl})`, value: "keep" },
  ];
  let baseUrl = await askChoice("API endpoint:", providerOptions);
  if (baseUrl === "custom") {
    baseUrl = await askString("Enter custom base URL");
  } else if (baseUrl === "keep") {
    baseUrl = currentUrl;
  }

  // Model selection
  const model = await askString(`Model name`, currentModel);

  // Worker model
  let workerModel = await askString(
    `Worker model (for memory generation, leave empty to use main model)`,
    currentWorker || "",
  );
  if (!workerModel) workerModel = "";

  // Write .env file
  const envPath = join(import.meta.dirname!, "..", ".env");
  const envContent = [
    `LLM_API_KEY=${apiKey}`,
    `LLM_BASE_URL=${baseUrl}`,
    `LLM_MODEL=${model}`,
  ];
  if (workerModel) {
    envContent.push(`WORKER_MODEL=${workerModel}`);
  }

  await Deno.writeTextFile(envPath, envContent.join("\n") + "\n");
  console.log(`\nConfiguration written to ${envPath}`);

  // Connection test
  const shouldTest = await askConfirm("Test connection?", true);
  if (shouldTest) {
    console.log("\nTesting connection...");
    const llm = new LLMClient({ apiKey, baseUrl, model });
    const result = await llm.testConnection();

    if (result.ok) {
      console.log(`  Connection OK (${result.latencyMs}ms)`);
      console.log(`  Model: ${result.model}`);
    } else {
      console.log(`  Connection FAILED (${result.latencyMs}ms)`);
      if (result.error) console.log(`  Error: ${result.error}`);
    }
  }

  console.log("\nConfiguration complete!");
  Deno.exit(0);
}
