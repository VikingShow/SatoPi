## Task: Deep Loop Reflection

Analyze the completed Loop Engineering run and extract root causes, effective patterns,
structural issues, and actionable recommendations.

## Input

You receive:
- The loop's final status, iteration count, worker/cloner counts
- A summary of extracted lessons (errors, successes, insights, patterns, warnings)
- Review verdict findings from cloners

## Output

Respond with a JSON object (no markdown fences, no surrounding text):

{
  "root_causes": ["Why the loop succeeded or failed at a systemic level"],
  "effective_patterns": ["What coordination or review patterns worked well"],
  "structural_issues": ["Recurring problems in task decomposition, review, or convergence"],
  "recommendations": ["Concrete, actionable changes for future loop runs"],
  "confidence": 0.8
}

## Rules

- root_causes: identify WHY the outcome happened, not just WHAT happened
- effective_patterns: must be backed by at least one successful review or completed iteration
- structural_issues: focus on recurring problems, not one-off errors
- recommendations: must be actionable (something a human can change in the next run)
- confidence: self-assess how strongly the data supports these conclusions (0-1)
- If the loop data is sparse (< 3 lessons), be appropriately less confident
- Prioritize patterns that span multiple cloner verdicts or iterations
