# Article standard

Use this reference when outlining, drafting, expanding, or reviewing a substantial article.

## What the local reference does well

`src/content/posts/agent-harness-engineering.md` succeeds because it works at several levels at once:

- a concise opening defines the engineering problem;
- an early map tells readers what the long article will cover;
- concept history prevents neighboring terms from collapsing together;
- a minimal loop makes the abstraction executable;
- each mechanism is tied to a concrete failure;
- structured payloads show what a real contract looks like;
- one end-to-end incident connects otherwise separate mechanisms;
- objections and non-use cases prevent the idea from becoming universal advice;
- evaluation criteria explain how a change can be tested;
- the ending leaves a practical decision table rather than a slogan.

Copy this standard of explanation, not the exact section sequence.

## Evidence ladder

Use the strongest evidence available and name its scope.

1. Reproduced behavior, executable tests, or source code.
2. Official specification, repository, or documentation.
3. Original research paper and its reported experiment.
4. Maintainer explanation or product announcement.
5. Secondary explanation.
6. Author inference, explicitly labeled.

Do not cite a secondary article when the linked primary source is available. Product announcements can support what a vendor claims or exposes, not an independent performance conclusion.

For every benchmark number, keep enough context to avoid turning it into advertising: task set, comparison, metric, and the limitation that affects interpretation.

## Length follows scope

Do not apply one length to every article. Decide how much of the system the piece has to explain.

| Class | Words | Floor / real target | Use when | Typical examples |
| --- | --- | --- | --- | --- |
| Flagship | 12,000–20,000+ | aim 15,000+ | a whole architecture, ecosystem, technology map, cross-cutting method, or an AI technique that needs full context | Agent harness, RAG map, FastCode, Repo Map, coding-agent source walkthrough |
| Focused | 6,000–12,000 | aim 8,000+ | a deliberately narrow topic outside the AI core | one backend subsystem, one engineering workflow |
| Field note | 2,000–6,000 | aim 3,500+ | one specific question, one bug, one narrow behavior | a single Redis eviction issue, one config trap |

AI and Agent topics are flagship by default. They usually need a system view, so the article should still cover context, mechanism, failure modes, and a worked example even when the title names one technique. The minimum is a floor, not a goal: a draft that only clears it is usually under-developed. Padding a small topic to flagship length is an error, and deliberately narrowing the class to avoid the AI depth requirement is also an error.

## Outline patterns

Choose the pattern that matches the subject.

### Architecture or source analysis

1. Problem and scope
2. Repository or module map
3. Minimal runtime model
4. Full request or event path
5. State, context, tools, permissions, persistence
6. Failure handling and observability
7. End-to-end trace
8. Trade-offs and comparison
9. Practical design lessons

### Research or new technique

1. Problem the paper tries to solve
2. What is genuinely new
3. Minimal mechanism
4. Full architecture or algorithm
5. Experimental setup and results
6. Ablations and negative findings
7. Reproduction or implementation sketch
8. Applicable and unsafe scenarios
9. Open questions

### Engineering method

1. Recurring failure
2. Smallest process that addresses it
3. Artifacts and ownership
4. End-to-end worked example
5. Integration with existing workflow
6. Failure modes and excessive use
7. Measurement and rollout
8. Adoption checklist

Mix patterns when the topic requires it. Do not force a paper into a product architecture outline.

## Depth checks

Before drafting, list the questions a skeptical engineer would ask. A flagship article should answer most of these:

- What is the precise problem?
- What neighboring idea is this commonly confused with?
- What is the smallest working mechanism?
- What changes in a production implementation?
- What state exists, and who owns it?
- What happens on timeout, partial failure, cancellation, or retry?
- What crosses a permission or trust boundary?
- How does a real request travel through the system?
- Which alternatives solve the same problem?
- When is the added complexity unjustified?
- What evidence supports the claimed improvement?
- How would a reader reproduce or falsify the conclusion?

## Worked example standard

Use one example across multiple sections instead of unrelated toy snippets. Define its initial state, goal, constraints, actions, observable evidence, and completion condition. When a failure occurs, show which layer detects it and what information reaches the next step.

An example should expose a real design choice. Renaming `foo` to `bar` does not count.

## Visual standard

Every visual answers one question. Good questions include:

- Which layer owns each responsibility?
- In what order does state move?
- Where does a decision branch?
- Which mechanism changes across alternatives?
- How does evidence flow into acceptance?

Keep diagrams readable at the article's actual content width. Use a light editorial background, one green accent family, neutral lines, and text with sufficient contrast. Never encode meaning by color alone. Include SVG accessibility metadata.

## Prose review

Run a dedicated revision after the technical draft:

- Cut paragraphs that only announce importance.
- Replace general praise with a mechanism or result.
- Remove repeated conclusions from section endings.
- Break uniform section rhythms.
- Keep uncertainty where sources are incomplete.
- Verify every number, version, date, and proper name.
- Ensure links point to the actual supporting page.
- Preserve concrete opinions, limitations, and unresolved tension.

## Definition of done

An article is ready when:

- a reader can explain the mechanism without memorizing product terminology;
- the implementation examples agree with the prose;
- limitations receive comparable care to benefits;
- major claims are traceable to evidence;
- the worked example reaches a verifiable outcome;
- images render and contribute information;
- the content build succeeds;
- the article audit has no unexplained warning;
- the rendered page has been inspected at desktop width.
