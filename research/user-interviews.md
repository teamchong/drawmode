# Drawmode User Interview Plan

## Goal

Validate three assumptions before building more features:
1. Code Mode (typed SDK) is better than prompt-based diagram generation
2. The iteration story (sidecar → edit → re-render) works in practice
3. Output quality (layout, arrows, colors) is good enough for real use

Target: 5-8 interviews across two segments. 30 min each.

---

## Segments

### Segment A: "Diagram makers" (3-4 people)
People who regularly create architecture diagrams, system diagrams, or flowcharts as part of their work.

**Where to find them:**
- Excalidraw Discord — people sharing complex diagrams
- r/softwarearchitecture — people posting architecture diagrams
- Dev.to / blog posts with architecture diagrams (the authors)
- HN threads about "diagramming tools" or "architecture diagrams" (commenters who share their workflow)
- MCP Discord — people using diagram MCP tools

**Screener:**
- Do you create architecture or system diagrams at least monthly?
- What tools do you currently use? (Excalidraw, Mermaid, draw.io, Lucidchart, tldraw, hand-drawn)
- Have you tried AI-assisted diagram generation?
- Do you use Claude Code, Claude Desktop, Cursor, or similar AI coding tools?

**Disqualify if:** Only creates diagrams once a year, no interest in AI tools, only uses Figma/design tools.

### Segment B: "AI tool power users" (2-4 people)
People who actively use Claude Code, Cursor, or similar tools and have tried MCP servers.

**Where to find them:**
- Claude Code GitHub issues — active users
- Cursor forums — people discussing MCP integrations
- X/Twitter — search "MCP server" or "claude code diagram"
- MCP Registry / Smithery — people browsing/installing MCP tools

**Screener:**
- Do you use Claude Code, Claude Desktop, or Cursor regularly?
- Have you installed any MCP servers?
- Have you tried to generate diagrams with AI? How?
- What's your typical diagram workflow? (prompt → screenshot → manual fix?)

**Disqualify if:** Never used AI coding tools, no interest in programmatic diagrams, only wants WYSIWYG.

---

## Interview Guide

### Opening (2 min)

> Thanks for chatting. I'm researching how developers create architecture diagrams — not pitching anything. There are no wrong answers. I'll ask about your experience, not about a specific tool.

### Part 1: Current workflow (10 min)

**Context question:**
> Walk me through the last time you created an architecture diagram. What did you do, step by step?

**Follow-ups (use as needed, don't force all):**
- What tool did you use? Why that one?
- How long did it take from "I need a diagram" to "I have a diagram"?
- What was the most tedious part?
- Did you iterate on it? How many revisions?
- Where does the final diagram live? (docs, README, Confluence, Notion, slide deck)

**Probe for specifics:**
> If they mention layout: "How did you decide where to put things? Did you manually drag nodes around?"
> If they mention arrows: "How did you handle the connections? Did any overlap or look wrong?"

**Key signal we're listening for:**
- How much time goes into layout vs content?
- Do they iterate or create once and forget?
- What format matters? (image, editable source, URL to share)

### Part 2: AI diagram generation (10 min)

**Context question:**
> Have you ever asked an AI (ChatGPT, Claude, Copilot) to create a diagram? What happened?

**Follow-ups:**
- What did you prompt it with? A description? A list of components?
- Was the output usable? What did you have to fix?
- Did you try Mermaid output? Raw SVG? Something else?
- What's the biggest gap between what AI generates and what you actually need?

**If they haven't tried AI diagrams:**
> If you could describe your system in a few sentences and get a diagram back, what would you need from that diagram?

**Probe for the "Code Mode" value prop:**
> If instead of describing the diagram in English, you wrote 10 lines of TypeScript like `addBox("API")`, `connect(api, db)`, and the tool handled all the layout and styling — would that be better or worse than a natural language prompt?

**Key signal:**
- Do they trust AI to do layout, or do they insist on manual control?
- Is the problem generating the first draft or iterating on it?
- Would they prefer code (explicit) or prompt (natural language)?

### Part 3: Output quality & iteration (5 min)

**Context question:**
> Show me (or describe) a diagram you're proud of. Now show me one that's "good enough." What's the difference?

**Follow-ups:**
- What makes a diagram look professional vs amateur?
- Do you care about consistent colors? Arrow routing? Alignment?
- If the tool got 80% of the way there, would you fix the last 20% manually?
- How do you handle updates when the architecture changes? Redraw from scratch?

**Probe for iteration workflow:**
> If the diagram source was a TypeScript file you could edit and re-run to get an updated diagram — would that change how you work?

**Key signal:**
- Is "good enough" acceptable, or do they need pixel-perfect?
- Do they value editability or just the final image?
- Would code-as-source-of-truth change their iteration pattern?

### Closing (3 min)

> If you were building a diagramming tool from scratch for developers, what's the #1 thing you'd make sure it does well?

> Is there anything I didn't ask about that matters to you?

> Can I follow up if I have one more question? (get permission for async follow-up)

---

## After each interview

Fill in the tracking sheet (research/interview-tracker.md):
- Participant ID (P1, P2, ...)
- Segment (A or B)
- Current tools
- Key quotes (verbatim, not paraphrased)
- Workflow: how they create diagrams today, time spent
- AI experience: what they've tried, what worked/didn't
- Quality bar: what "good enough" means to them
- Iteration: do they edit diagrams, how often
- Surprise: anything unexpected

---

## Outreach templates

### Cold DM (Discord/Twitter)

> Hey — I'm researching how devs create architecture diagrams (Excalidraw, Mermaid, draw.io, etc). Not selling anything. Would you be up for a 30-min chat about your workflow? I'll share what I learn with the community afterward.

### Forum/thread reply

> Nice diagram! I'm doing user research on how devs create architecture diagrams — what tools they use, what's tedious, what AI could help with. Would you be open to a quick 30-min chat? DM me if interested.

### Follow-up after agreement

> Thanks! Here's a Calendly/time link: [LINK]
>
> Quick context: I'll ask about your experience creating architecture diagrams — what tools you use, what's painful, what you wish existed. No prep needed. I'll share anonymized findings afterward if you're interested.

---

## Decision framework

After 5+ interviews, synthesize into:

| Assumption | Validated? | Evidence | Action |
|-----------|-----------|----------|--------|
| Code Mode > prompt-based generation | Yes/No/Partial | Quotes + patterns | Keep/kill/pivot SDK approach |
| Sidecar iteration workflow works | Yes/No/Partial | Quotes + patterns | Keep/kill/pivot .drawmode.ts |
| Output quality is good enough | Yes/No/Partial | Quotes + patterns | Invest in layout/polish or accept "good enough" |

**Decision rules:**
- If 4/5+ people validate → double down, ship prominently
- If 2-3/5 validate → keep but don't prioritize, dig deeper on the alternative
- If 0-1/5 validate → kill or radically rethink

What we learn should directly change the README messaging, feature priority, and what we build next.

---

## Completed Interviews

### Interview 1 — Internal dogfooding (2026-03-06)

**Participant:** Internal tester (Segment B — AI tool power user)
**Tools:** Claude Code + drawmode MCP
**Task:** Generate architecture diagram for a real Cloudflare Workers project

**Key quotes:**
- "SDK is intuitive — addBox, connect, addGroup with row/col grid layout is easy to reason about."
- "Color presets are great — zero time spent picking colors."
- "Icons are a nice touch — added visual clarity with no effort."
- "Single tool call — one shot to go from code to rendered SVG. Very fast."

**Pain points identified:**
1. No sidecar for SVG format → **Fixed** (sidecar now written for all formats)
2. Can't verify output inline → **Addressed** (multi-format: `["excalidraw", "png"]`)
3. Grid layout is a black box → **Fixed** (documented constants in SDK reference)
4. No group positioning control → **Fixed** (GroupOpts: padding, strokeColor, strokeStyle, opacity)
5. Single format per render call → **Fixed** (multi-format array support)
6. Label \n undocumented → **Fixed** (documented in SDK reference + tool description)
7. Edge label placement → **Fixed** (labelPosition: "start" | "middle" | "end")

**Rating:** 8/10 — "Happy path is excellent. Iteration story needs work."

**Actions taken:** All 7 pain points addressed in commits `e24e267` through `48c24cf`.
