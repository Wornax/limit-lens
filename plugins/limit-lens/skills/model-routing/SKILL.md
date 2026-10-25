---
name: model-routing
description: Pick the right model (Haiku, Sonnet or Opus) and effort for each piece of work before delegating it, so routine work doesn't burn the usage limit on Opus and risky work doesn't land on a weak model. Use before starting any subagent (Agent tool), workflow agent, or reviewer; when writing a brief someone else will execute; and when the main session is about to do long mechanical work itself (serial merges, running tests, reading many files, mass renames).
---

# Route work to Haiku, Sonnet or Opus

**Who this is for:** whoever coordinates, meaning the main session or a workflow. A subagent does not delegate: it does its task on the model it was started with, and if the task is above that model it hands the request back to the coordinator.

**Why it matters:** you pay in usage limit, and Opus spends it much faster. List prices give the ratio:

| Model | Id | Input / output per million tokens | Relative to Opus output |
|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | $4 / $20 | 1 |
| Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | 1/2 |
| Haiku 5.5 | `claude-haiku-5-5` | $0.10 / $0.50 (prompts over 100K tokens: $0.50 / $2.50) | 1/40 |

A simple task on Opus wastes limit. A hard task on Haiku comes back wrong and costs more than doing it right once. A risky task on a weak model can break something that can't be undone.

**The rule:** use the smallest model that gets it right on the first try without putting anything risky at stake, and always say which one you picked.

## 1. Always pass the model and effort explicitly

- **Without a model,** an agent runs on the model in its definition, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main session's model, which is often Opus. A model passed when the agent is started overrides the definition's `model:`, which is how an agent defined with `model: sonnet` ends up on Opus.
- **Without an effort,** the agent inherits the session's effort, which is often high.

So:
- **Agent tool:** pass `model` (`"haiku"`, `"sonnet"` or `"opus"`) on every call, even with a `subagent_type`, plus the effort from section 4. This skill is the instruction that asks for both.
- **Workflows:** pass a model, and an effort where the script API supports it, to every `agent()` call.
- **Resuming an agent** (for example with SendMessage) keeps the model it started with. To change model, start a new agent with the full brief.
- **Check afterwards:** `/limit-lens:report` shows which models your subagents and workflow agents actually ran on.

## 2. How to classify: three questions, in this order

**1. Is a mistake here expensive or hard to undo?** This covers money and pricing, user data (profiles, migrations, databases), security and authentication, tenant isolation, publishing and deploys, and the project's fixed rules.

If yes:
- **Design on Opus.**
- **Execution on at least Sonnet at high effort,** never Haiku.
- **Review on Opus before merging:** max effort for money and user data, high for the rest.
- **Fixes to a critical or important finding** go back to Opus to confirm.
- **Never merge without the verdict.**

**2. Is there an answer key?** A clear brief with a test, a command, or a check that says whether it worked.
- **Yes, and the steps are fixed** (known recipe, no decisions along the way): **Haiku**.
- **Yes, but it needs to understand code, write something new, or solve problems along the way:** **Sonnet**.
- **No.** The task is deciding what to do, designing, or weighing trade-offs: **Opus**.

Finding a bug's cause starts on Sonnet at high effort, with a test that reproduces it. It moves to Opus after two failed attempts, or if the bug crosses several systems or touches a fixed rule.

**3. How much context has to fit in mind at once?**
- **One file, one command, or one list:** Haiku.
- **One module with its tests, or one brief:** Sonnet.
- **Several systems plus the history of decisions:** Opus.

**If the questions disagree,** the largest model wins. The exception is question 3 when the brief comes with a ready checklist: then the smaller model wins, as long as question 1 didn't say "risk".

## 3. Pocket table

| Haiku (cheap and fast) | Sonnet (the executor) | Opus (thinks and decides) |
|---|---|---|
| Run tests, lint or a build and report the failures | Implement a task from a brief, tests first | Design a system, a product rule or an architecture |
| Read a test, build or CI log and summarize the failures | Fix the findings of a review | Decide the order and priority of work |
| Find where something is used and list files and lines | Resolve merge conflicts that are purely additive, with the test suite as the check | Resolve semantic conflicts (both sides change the same function, rule or decision) |
| Rename from a ready list of pairs in docs and comments only | Rename in code, with the test suite run in the same change | Review risky work (money, user data, security, deploys) before merging |
| Replace given values in text files from a ready list, then run the check | Write a brief from a design that is already decided | Write the brief when the design has gaps or the task is risky |
| Read-only status checks: git state, running processes, free memory | Debug with a reproducing test (high effort) | Diagnose a bug Sonnet missed twice |
| Append lines someone already wrote to a changelog or decision log | Data analysis against given targets | Accept or reject a delivery by reading the full report and diff, not a summary |
| Download files, convert formats, run a checker and report | Review an ordinary, low-risk change | Answer the person about direction and what to do next |

**An attempt counts** when its report says what was tried and what was ruled out. If the first one came back with no cause and no evidence, count it as two.

## 4. Effort

| Model | Effort |
|---|---|
| Haiku | `low`, or `medium` when there are several steps |
| Sonnet | `medium` for ordinary execution; `high` for hard code, risky tasks and bug diagnosis |
| Opus | `high` for design, diagnosis and review; `max` only for reviews of money and user data and the review before a release. The docs warn that `max` can overthink |

## 5. The main session

The coordinator usually runs on Opus with a large context, so every step it takes is expensive, even a `git status`: each request re-reads the whole conversation.

- **No serial manual work in the main session.** Three merges in a row, five log reads or a 40-file rename go to one Haiku or Sonnet agent, all at once, with the full list.
- **Keep agent tasks bounded.** An agent that makes hundreds of tool calls re-reads its own growing context on every one; split long jobs into scoped agents that return short summaries.
- **A loop tick** (`/loop`, scheduled wakeups) that only checks something should be short. With more than three mechanical steps, have a Haiku agent check and summarize.
- **The main session keeps:** deciding, designing, writing briefs that need judgment, accepting or rejecting deliveries, and talking to the person.
- **When the coming days are mostly execution,** tell the person they can run the main session on Sonnet (`/model sonnet`) and call Opus only to design and review. That switch is their decision. Warn them that with the session on Sonnet, risky changes need an explicit Opus review before merging.

## 6. Moving up and down

- **Move up** when the smaller model:
  - returned something incoherent;
  - ignored a fixed rule;
  - failed twice at the same thing;
  - or asked for a decision that wasn't in the brief.

  The larger model gets the brief, what was tried and what was ruled out.
- **Move down** when the same task has repeated with a stable recipe and a command that checks it. It becomes a Haiku task, ideally with its own agent that has the steps written down.
- **Never move down to Haiku**, however repeated the recipe:
  - risk reviews;
  - design;
  - decisions the person will feel in the product;
  - any execution that touches money, user data, security or publishing.

## 7. Write the choice down

In the brief, the agent prompt, or the workflow label, add one line: **"Model: Sonnet, effort medium, because there is a brief and tests."** Whoever reads it later knows why, and the person can push back when the choice is wrong.
