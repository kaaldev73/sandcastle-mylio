// Sequential Planner with Review — multi-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             A Claude Code agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). Issue pipelines run one
//                               at a time, in plan order.
//   Phase 3 (Merge):            After each issue's pipeline, an agent merges
//                               that branch into the current branch before the
//                               next issue starts.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// All agents use this model; there is deliberately no environment override.
const model = "claude-sonnet-5-5";

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const plan = await sandcastle.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    // One iteration is enough: the planner just needs to read and reason,
    // not write code. (Structured output requires maxIterations: 1.)
    maxIterations: 1,
    agent: sandcastle.claudeCode(model),
    promptFile: "./.sandcastle/plan-prompt.md",
    // Extract and validate the <plan> JSON into a typed object. Throws
    // StructuredOutputError if the tag is missing, the JSON is malformed, or
    // validation fails — which aborts the loop.
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = planSchema.parse(plan.output).issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  console.log(
    `Planning complete. ${issues.length} issue(s) to work sequentially:`,
  );
  for (const issue of issues) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each issue, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  //
  // Issues are processed sequentially, each merged before the next starts.
  // -------------------------------------------------------------------------

  const runPipeline = async (issue: (typeof issues)[number]) => {
    const sandbox = await sandcastle.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
      hooks,
      copyToWorktree,
    });

    try {
      // Run the implementer
      const implement = await sandbox.run({
        name: "implementer",
        maxIterations: 100,
        agent: sandcastle.claudeCode(model),
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      });

      // Only review if the implementer produced commits
      if (implement.commits.length > 0) {
        const review = await sandbox.run({
          name: "reviewer",
          maxIterations: 1,
          agent: sandcastle.claudeCode(model),
          promptFile: "./.sandcastle/review-prompt.md",
          promptArgs: {
            BRANCH: issue.branch,
          },
        });

        // Merge commits from both runs so the merge phase sees all of them.
        // Each sandbox.run() only returns commits from its own run.
        return {
          ...review,
          commits: [...implement.commits, ...review.commits],
        };
      }

      return implement;
    } finally {
      await sandbox.close();
    }
  };

  // -------------------------------------------------------------------------
  // Phase 3: Merge (per issue)
  //
  // After each issue's implement + review pipeline, a merger agent merges that
  // branch into the current branch, resolving conflicts and running tests, so
  // the next issue's branch starts from a tree that includes this work.
  //
  // The {{BRANCHES}} and {{ISSUES}} prompt arguments are lists that the agent
  // uses to know which branches to merge and which issues to close.
  // -------------------------------------------------------------------------
  const mergeIssue = (issue: (typeof issues)[number]) =>
    sandcastle.run({
      hooks,
      sandbox: docker(),
      name: "merger",
      maxIterations: 1,
      agent: sandcastle.claudeCode(model),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        // A markdown list of branch names, one per line.
        BRANCHES: `- ${issue.branch}`,
        // A markdown list of issue IDs and titles, one per line.
        ISSUES: `- ${issue.id}: ${issue.title}`,
      },
    });

  // Run issues one at a time. A failure is logged and doesn't stop the
  // remaining issues.
  let mergedCount = 0;
  for (const issue of issues) {
    console.log(`\n--- Working on ${issue.id}: ${issue.title} ---`);
    try {
      const result = await runPipeline(issue);

      // An agent that ran successfully but made no commits has nothing to merge.
      if (result.commits.length === 0) {
        console.log(`  ${issue.id}: no commits produced. Nothing to merge.`);
        continue;
      }

      console.log(`  ${issue.id}: merging ${issue.branch}`);
      await mergeIssue(issue);
      mergedCount++;
    } catch (reason) {
      // Network error, sandbox crash, etc.
      console.error(`  ✗ ${issue.id} (${issue.branch}) failed: ${reason}`);
    }
  }

  console.log(`\nIteration complete. ${mergedCount} branch(es) merged.`);
}

console.log("\nAll done.");
