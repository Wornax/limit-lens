---
name: model-routing
description: Pick the right model (Haiku, Sonnet or Opus) and effort for each piece of work before delegating it, so routine work doesn't burn the usage limit on Opus and risky work doesn't land on a weak model. Use before starting any subagent (Agent tool), workflow agent, or reviewer; when writing a brief someone else will execute; and when the main session is about to do three or more mechanical steps itself (serial merges, running tests, reading many files, mass renames).
---

# Route work to Haiku, Sonnet or Opus

**Who this is for:** whoever starts agents: the main session, a workflow, or a subagent that can start its own. An agent working on a task it was given does it on the model it was started with, and if the task is above that model it hands the request back to whoever started it.

**Why it matters:** the model you run on changes how fast you reach your usage limit, and Opus costs the most per token. Anthropic does not publish how plan limits weigh each model, but list prices are the best guide: output costs roughly Opus 1, Sonnet 1/2, Haiku 1/40, and a Haiku 5.5 request whose prompt is over 100K tokens pays a higher tier (about 1/8 of Opus on output), so keep Haiku agents short. See the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing); `/limit-xray:report` shows which models your work actually ran on. A simple task on Opus wastes limit. A hard task on Haiku comes back wrong and costs more than doing it right once. A risky task on a weak model can break something that can't be undone.

**The rule:** use the smallest model that gets it right on the first try without putting anything risky at stake, and always say which one you picked.

## 1. Always pass the model and effort explicitly

- **Which model an agent gets, highest first:** the `model` passed when it is started, then the `model:` in its definition, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the main session's model (often Opus). If `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is set, that variable wins over everything and per-call choices are ignored: say so instead of promising a routing you can't deliver.
- **Without an effort,** the agent inherits the session's effort, which is often high.

So:
- **Agent tool:** pass `model` (`"haiku"`, `"sonnet"` or `"opus"`) on every call, even with a `subagent_type`, and pass the `effort` from section 4. The Agent tool only sets effort when an instruction asks for it; this skill is that instruction.
- **Agent definitions:** set `model:` and `effort:` in the frontmatter of agents that always do the same kind of work.
- **Workflows:** pass a model and an effort to every `agent()` call.
- **Resuming an agent** (for example with SendMessage) keeps the model it started with. To change model, start a new agent with the full brief.
- **Check afterwards:** `/limit-xray:report` shows which models your subagents and workflow agents actually ran on.

## 2. How to classify: three questions, in this order

**1. Is a mistake here expensive or hard to undo?** This covers money and pricing, user data (profiles, migrations, databases), security and authentication, multi-tenancy boundaries, publishing and deploys, and the rules in CLAUDE.md or the brief.

If yes:
- **Design on Opus.**
- **Execution on at least Sonnet at high effort,** never Haiku.
- **Review on Opus before merging:** max effort for money and user data, high for the rest.
- **Fixes to blocking review findings** go back to Opus to confirm.
- **Never merge without the verdict.**

**2. Is there an answer key?** A clear brief with a test, a command, or a check that says whether it worked.
- **Yes, and the steps are fixed** (known recipe, no decisions along the way): **Haiku**.
- **Yes, but it needs to understand code, write something new, or solve problems along the way:** **Sonnet**.
- **No, and the task is deciding what to do, designing, or weighing trade-offs:** **Opus**. A task with no automated check but a stated standard to work against (a decided design, given targets, an ordinary low-risk review) is **Sonnet**.

Finding a bug's cause starts on Sonnet at high effort, with a test that reproduces it. It moves to Opus after two failed attempts, or if the bug crosses several systems or touches a rule from question 1. An attempt counts when its report says what was tried and what was ruled out; one that came back with no cause and no evidence counts as two.

**3. How much context has to fit in mind at once?**
- **One file, one command, or one list:** Haiku.
- **One module with its tests, or one brief:** Sonnet.
- **Several systems plus the history of decisions:** Opus.

**If the questions disagree,** take the larger model, except when a ready checklist covers a large-context task (question 3) and question 1 found no risk. For the tasks listed in the pocket table below, the table wins.

## 3. Pocket table

| Haiku (cheap and fast) | Sonnet (the executor) | Opus (thinks and decides) |
|---|---|---|
| Run tests, lint or a build and report the failures | Implement a task from a brief, tests first | Design a system, a product rule or an architecture |
| Read a test, build or CI log and summarize the failures | Fix the findings of a review | Decide the order and priority of work |
| Find where something is used and list files and lines | Resolve merge conflicts that are purely additive, with the test suite as the check | Resolve semantic conflicts (both sides change the same function, rule or decision) |
| Rename from a ready list of pairs in docs and comments only | Rename in code, with the test suite run in the same change | Review risky work before merging |
| Replace given values in text files from a ready list, then run the check | Write a brief from a design that is already decided | Write the brief when the design has gaps or the task is risky |
| Read-only status checks: git state, running processes, free memory | Data analysis against given targets | Accept or reject delivered work by reading the full diff, not a summary |
| Append lines someone already wrote to a changelog | Review an ordinary, low-risk change | Discuss direction and next steps with the user |

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
- **The main session keeps:** deciding, designing, writing briefs that need judgment, accepting or rejecting delivered work, and talking to the user.
- **When the coming days are mostly execution,** tell the user they can run the main session on Sonnet (`/model sonnet`, chosen at the start of a session, since switching mid-session rebuilds the cache) and call Opus only to design and review. That switch is their decision. With the session on Sonnet, risky changes need an explicit Opus review before merging.

## 6. Moving up and down

- **Move up** when the smaller model returned something incoherent, ignored a rule from CLAUDE.md or the brief, failed twice at the same thing, or asked for a decision that wasn't in the brief. The larger model gets the brief, what was tried and what was ruled out.
- **Move down** when the same task has repeated with a stable recipe and a command that checks it. It becomes a Haiku task, ideally with its own agent that has the steps written down.
- **Never move down to Haiku** risk reviews, design, decisions that change user-visible behavior, or execution that touches anything from question 1, however repeated the recipe.

## 7. Write the choice down

In the brief, the agent prompt, or the workflow label, add one line: **"Model: Sonnet, effort medium, because there is a brief and tests."** Whoever reads it later knows why, and the user can push back when the choice is wrong.
