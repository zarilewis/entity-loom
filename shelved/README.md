# Shelved Features

Code here is preserved for potential future use but not active in the build.

## core-prompt-extractor.ts

Two-phase LLM pipeline that reads conversations from the Psycheros DB and extracts
enduring personality/relationship patterns for Core Prompt files.

**Why shelved**: Tested against a 14-day SillyTavern chat log (408 messages).
The LLM call volume (6+ Phase 1 chunks + Phase 2 aggregation) was too slow and
costly to be practical at scale. The automated output, while structurally sound,
didn't match the quality of Core Prompts written collaboratively by the entity
and user. Manual co-creation remains the better approach.

**To resurrect**:
1. Copy back to `src/writers/core-prompt-extractor.ts`
2. Re-add export to `src/writers/mod.ts`
3. Re-add `extractCommand` to `src/cli/commands.ts` (see git history)
4. Re-add `extract` to COMMANDS tuple and switch in `src/main.ts`
5. Re-add `"extract"` task to `deno.json`
6. Update CLAUDE.md
