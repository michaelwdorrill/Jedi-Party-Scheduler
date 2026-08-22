# 0008 — Visual design pass: three pitches

**Status:** Pitches — awaiting a choice
**Covers:** `IDEAS.md` items 8 and 20 · **Phase:** 3.5 · **Ships in:** v0.4

## Why this file is pitches and not a spec

`ROADMAP.md` singles this item out:

> Idea 8 is also the one item on this roadmap that wants *options* rather
> than a spec: pitches to choose between, then a spec for the chosen one.

So this document does not decide anything. It audits what we have, states
what all three directions share, and puts three of them side by side with
their costs. The chosen one gets spec `0009`, written to the usual standard,
and that is what gets built.

Idea 20 (merge the Dashboard into the Calendar) is folded in rather than
sequenced around, for the reason its own entry gives: Phase 3.5 styles "the
set of views that survived Phase 3", and idea 20 changes which views there
are. **Every pitch below therefore draws the merged landing page**, and each
answers idea 20's four open calls differently. Those calls are layout calls,
so the chosen pitch answers them — that was the plan, and it holds.

## What we are starting from

Idea 8 says the app "has had zero design attention — it's functional, not
designed." That is accurate, and it is worth being precise about what it
means in code, because the size of the foundation work is the same under all
three pitches and it is most of the cost.

| Measure | Today |
|---|---|
| `tailwind.config.js` `theme.extend` | `{}` — empty. No colour, type, spacing or radius tokens of any kind. |
| Distinct Tailwind slate steps in use | 9 (`slate-100` … `slate-900`), chosen ad hoc per file |
| Copies of the card pattern `rounded-lg border border-slate-800 bg-slate-900` | 17 |
| Copies of the text-input pattern | 29 |
| Copies of the secondary-button pattern | 10 |
| `bg-indigo-600` occurrences | 25 |
| Shared UI primitives (Button, Card, Field, PageHeader) | 0 |
| Files with any `focus`/`focus-visible` styling | **0 of 27** |
| `aria-*` attributes in the whole app | **0** |
| Web font loaded | none — browser default sans |

4,085 lines of TSX with no tokens and no primitives. Nothing here is *wrong*
exactly; it is what a functional-not-designed app looks like from the inside.
But it means "restyle the app" currently costs 17 card edits and 29 input
edits, and it is why every pitch shares the same foundation below.

The two accessibility zeroes are the ones to sit up at. There is no visible
focus ring anywhere, so the app is not keyboard-navigable in any comfortable
sense, and there is not one ARIA attribute in it.

## Findings that constrain the pitches

Two things surfaced while reading the code for this. Both are captured in
`IDEAS.md` (items 21 and 22) rather than fixed here, but they bear on the
choice.

**1. The calendar can only ever show this month and next month.**
`CalendarPage` holds `tab: 0 | 1`, and `monthWindow(monthsFromNow: 0 | 1, …)`
takes that literal type. There is no arbitrary month paging in the app at
all. This matters because idea 20's first open call — "does the sidebar
follow the calendar, or stay anchored to now?" — was framed on the premise
that "the grid pans to arbitrary months". It doesn't. The grid moves by one
month, once. That makes the whole question far cheaper than it looked, and
in two of the three pitches it stops being a question at all.

**2. Clicking an event chip in the month grid is broken.** `MonthCalendarGrid`
renders each day cell as `<button onClick={…}>` and puts `EventChip` — which
renders a react-router `<Link>`, i.e. an `<a href>` — *inside* it. An anchor
inside a button is invalid HTML and collapses the two into one ambiguous
control for keyboard and screen-reader users. It is also a live behavioural
bug: a click on the chip fires the chip's navigation *and* then bubbles to
the day cell's `onDayClick`, which calls `navigate('/events/new?date=…')`.
The day-cell handler runs second, so the New Event form is what you land on
— clicking an event on the calendar does not open that event.

The nesting and the double-fire are plain from the code. The exact landing
page should be confirmed against the deployed sandbox before we write the fix
into 0009, since that is precisely what the sandbox is for.

This is a design finding as much as a bug: the day cell is trying to be two
controls at once. All three pitches below have to say what a day cell *is*,
and none of them can keep the current answer.

## The foundation all three pitches share

This is the bulk of the work and it does not vary between them. It is worth
approving on its own even if the visual direction takes another round.

1. **Real tokens in `tailwind.config.js`.** Semantic names, not raw palette
   steps: `surface`, `surface-raised`, `border`, `text`, `text-muted`,
   `accent`. Nine ad-hoc slate steps collapse to a deliberate ramp. This is
   what makes the *next* restyle cheap, and the reason to do it now rather
   than after v0.5's bot work adds more surfaces.
2. **Four primitives** — `Button` (primary/secondary/ghost/danger), `Card`,
   `Field`, `PageHeader` — replacing 17 + 29 + 10 hand-rolled copies. Purely
   mechanical, individually reviewable, no visual change on its own.
3. **A focus-visible ring on every interactive element**, from the shared
   primitives, so it cannot be forgotten per-component the way it has been
   27 times.
4. **A typeface.** Any of the three wants one; they differ on which.
5. **Fixing the day cell** per finding 2 — forced, because all three change
   what a day cell does.

Items 1–3 are the ones that pay for themselves regardless of the pitch
chosen, and 5 is a bug fix we now can't unsee.

## The three pitches

They differ on one axis deliberately: **how much changes.** A refines, B
re-themes, C re-structures. That is the actual decision — "which of these
looks nicest" is downstream of "how far do we want to move".

---

### Pitch A — Quiet Utility

**Thesis.** The app answers one question — *when are we playing?* — and its
job is to answer it in as few glances as possible. Don't add personality; add
craft. This is the Linear/Height reading: dense, calm, neutral, one accent
colour used sparingly enough that it means something.

**Look.** Keep the dark ground but move off Tailwind's cold blue-slate to a
neutral charcoal ramp, so the group chip colours are the only saturated thing
on screen. Inter (or the system UI stack, properly specified) with a tight
type scale and tabular numerals for date numbers. Chips get a leading colour
bar rather than a full fill — group colour still reads instantly, but eight
saturated blocks stop competing with each other in a dense week.

**Landing page.** Month grid left (~62%), a "Next up" rail right (~38%).

**Idea 20's four calls:**
- *Anchoring:* rail is always anchored to now, and says so with a small
  "from today" label. Given finding 1 the grid moves at most one month, so
  the second query is the same now→+60d one the Dashboard already runs.
- *Mobile:* rail stacks **above** the grid. On a phone, "what's next" beats
  "the shape of the month".
- *Routes:* merged view owns `/`; `/calendar` becomes a redirect; the nav
  loses the word "Dashboard" and reads Calendar / Groups / Settings.
- *Header and buttons:* the "Welcome back, {name}" line is **cut** — it is a
  greeting, not information, and the name is already in the top bar. The two
  action buttons sit top-right of the calendar column. The `guilds.length === 0`
  empty state moves into the rail, where it reads as "nothing to show you
  yet, here's why" instead of gating the whole page.

**Day cell becomes:** a non-interactive container. Chips are the only links;
an explicit "+" appears on hover/focus for "new event on this day". Fixes
finding 2 cleanly.

**Cost:** smallest. Mostly tokens + primitives + one new two-column layout.
**Risk:** smallest, and the least memorable outcome. A year from now this is
"the app looks tidy" rather than "the app looks like something".

---

### Pitch B — The Table

**Thesis.** This is a hobby app for a group of friends, not a work tool, and
it is called *Uncle Owen*. It should feel like an object from the hobby. The
scheduler that people actually enjoy opening is the one that has a bit of
warmth in it — and warmth is the one thing a slate-and-indigo admin panel
structurally cannot have.

**Look.** A warm dark — "lamplit" — rather than the current cold one: warm
charcoal and umber surfaces, parchment-toned text, a brass/amber accent
instead of indigo. A display serif for headings and event titles against a
clean sans for UI chrome and data. A hand-tuned eight-colour group palette
built *for* the warm ground, replacing the current Tailwind-default eight
(which were picked for a blue-black background and go muddy on anything
warmer).

Staying dark-first is deliberate: the app's users are Discord users, and a
light-mode-first pitch would be a second, larger argument bundled into this
one. A light theme stays possible later precisely because of the token work.

**Landing page.** Same two-column split as A, but the rail is an *itinerary*
— day cards with date, title, time, and who's coming — rather than a compact
list.

**Idea 20's four calls:**
- *Anchoring:* anchored to now, as A.
- *Mobile:* rail stacks **below** the grid. In this direction the grid is the
  hero and should stay the first thing you see.
- *Routes:* identical to A.
- *Header and buttons:* the greeting **stays** here, paired with today's date
  — it fits a warm direction where it is dead weight in a cold one. Buttons
  top-right. Empty state in the rail, as A.

**Day cell becomes:** as A — container, not button.

**Cost:** medium. Everything in A, plus a bespoke palette, a second typeface,
and re-tuning chips, badges and RSVP states against a warm ground.
**Risk:** the highest-variance option. It is the only one that produces an
app with a *look*, and it is the only one that can be actively disliked. It
also dates faster than A.

---

### Pitch C — Agenda-first

**Thesis.** The month grid is the wrong primary. Most weeks in this app have
zero to three sessions in them, so a seven-column grid spends most of its
pixels on empty cells — and the current cell caps at three chips anyway. If
the question is "when are we playing", the honest primary is a list.

This is the boldest reading of idea 20: rather than the itinerary becoming a
sidebar next to the calendar, **the itinerary becomes the page and the
calendar becomes the sidebar.**

**Look.** Can borrow A's or B's palette — this pitch is about structure, and
composes with either. Its own contribution is typographic: a strong day-header
rhythm (Today / Tomorrow / Fri 29 Aug), generous rows, real hierarchy between
title, time, and attendees.

**Landing page.** Agenda as the wide primary column, grouped by day. A compact
month mini-calendar sits top-right as a *navigator* and density indicator —
dots under dates that have something on them — with the group filter beneath
it.

**Idea 20's four calls:**
- *Anchoring:* the question dissolves. There is one range (now → +60d) and one
  query. The mini-calendar is a jump control, not a second viewport: clicking
  a date scrolls the agenda to it. Finding 1's two-month ceiling stops being a
  visible limitation and becomes just how far the agenda runs.
- *Mobile:* this pitch **wins on mobile** and it is its strongest argument.
  The agenda is already a single column, so the phone layout is the desktop
  layout minus the navigator, which collapses behind a "jump to date" control.
  A and B both have to design a real second layout; C mostly doesn't.
- *Routes:* merged view owns `/`. `/calendar` redirects — but note this
  demotes the grid to a panel, so if the grid is something people rely on,
  this is the pitch that takes it away.
- *Header and buttons:* buttons top-right of the agenda column. The
  `guilds.length === 0` state becomes the agenda's own empty state, which is
  the most natural home any of the three gives it.

**Day cell becomes:** moot — there are no day cells in the primary view, and
the navigator's dates are unambiguously jump controls. Finding 2 disappears
rather than being fixed.

**Cost:** largest. A new agenda component, a new mini-calendar navigator, and
scroll-sync between them.
**Risk:** it gives up at-a-glance month shape, which is genuinely useful when
you are trying to *find a free evening* rather than *check what's on* — and
this app's whole job includes the former. Mitigation is density dots on the
navigator, but that is strictly less information than the grid.

---

## Side by side

| | **A — Quiet Utility** | **B — The Table** | **C — Agenda-first** |
|---|---|---|---|
| Changes | Refines | Re-themes | Re-structures |
| Primary view | Month grid | Month grid | Agenda list |
| Palette | Neutral charcoal, one accent | Warm dark, brass accent | Either |
| Type | One sans, tight scale | Serif + sans | Either + strong day rhythm |
| Mobile | Rail above grid | Rail below grid | Near-free |
| Greeting line | Cut | Kept | Cut |
| Grid's 2-month ceiling | Still visible | Still visible | Hidden by design |
| Effort | S–M | M | M–L |
| Risk | Low / forgettable | High variance | Loses month shape |

## What is deliberately not in these pitches

- **A light theme.** Every pitch is dark-first. The token work makes a light
  theme cheap later; bundling it here doubles the surface to review.
- **Fixing the two-month ceiling** (finding 1 / idea 22). It is a real
  limitation, but it is a behaviour change, not a design one, and C's value
  partly depends on the ceiling being invisible rather than raised.
- **The server noticeboard** (`0007`). Blocked on a Privacy Policy rewrite and
  unscheduled. Its future surface should be *considered* by the chosen pitch —
  a server view has to live somewhere — but not drawn.
- **Any worker change.** Idea 20 needs none, as its entry establishes: both
  pages already call `GET /me/events`. If a pitch turns out to need a worker
  change, that is a signal the pitch drifted.

## Open questions the choice does not answer

1. **Does the grid earn its place?** C bets no. Worth answering with the real
   calendar rather than in the abstract — how many chips does a typical
   fortnight actually hold?
2. **Do the eight group colours survive a redesign?** They are Tailwind
   defaults on a blue-black ground. B replaces them outright; A and B both
   need to check eight-way distinguishability, which was never verified.
3. **Should the primitives land first, separately?** Foundation items 1–3 are
   mechanical and pitch-independent. Landing them as their own branch would
   make the visual diff afterwards small and readable, at the cost of one
   extra sandbox round trip. Recommended, but it is a call.
4. **Where does a future server view hang off the chosen navigation?** Not
   drawn here, but the pitch that has no obvious home for it is the pitch
   that will fight `0007` later.

## Rejected alternatives

- **A component library (shadcn/ui, Radix, Mantine).** Real appeal — it would
  bring the focus states and ARIA the app has none of. Rejected for now: the
  app is 27 components and four primitives cover 17 + 29 + 10 of the
  duplication, so the library would be carrying weight it isn't paid for, and
  it would set the visual direction by default rather than by choice, which is
  the one thing this document exists to avoid. Worth revisiting at v0.5 when
  the bot adds surfaces.
- **Design the pass first, merge the Dashboard after.** This is the
  double-payment idea 20's entry rules out, and Rule 3 of the roadmap's
  ordering rules rules out generally.
- **Skipping the pitches and going straight to a spec.** The roadmap
  explicitly asks for options here, and this is the one item on it that does.
- **A pure CSS-level restyle with no layout change.** Cheaper, but it would
  style the two-tab split that idea 20 removes — i.e. it styles views that are
  about to stop existing.
