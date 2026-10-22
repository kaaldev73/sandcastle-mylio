# ISSUES

Here are the open issues in the repo:

<issues-json>

!`gh api 'repos/kaaldev73/sandcastle-mylio/issues?state=open&labels=ready-for-agent&per_page=100' --jq '[.[] | select((.pull_request|not) and (.sub_issues_summary.total == 0) and (.issue_dependencies_summary.blocked_by == 0)) | {number, title, body, labels: [.labels[].name]}]'`

</issues-json>

The list above has already been filtered to leaf tickets labelled `ready-for-agent` that have no open blockers (GitHub's native blocking links), so every issue listed is unblocked on dependencies. Still check the issues against each other and drop any pair likely to cause merge conflicts, keeping the one that should land first.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

An issue B is **blocked by** issue A if:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

An issue is **unblocked** if it has zero blocking dependencies on other open issues.

For each unblocked issue, assign a branch name using the exact format `sandcastle/issue-{id}` (no slug or other suffix). This must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

Include only unblocked issues. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
