# 0009 — Binary sunset: the v0.4 visual identity

**Status:** Ready
**Covers:** `IDEAS.md` items 8 and 20 · **Phase:** 3.5 · **Ships in:** v0.4
**Supersedes:** `0008-visual-design-pass.md`

## Why this replaced 0008

0008 put three directions up — refine, re-theme, re-structure — and the review
rejected all three on the same ground:

> "All of these are a little lacking as far as visual designs are concerned.
> There's some layout, there's some palette work, but as a visual whole it
> doesn't feel distinctive."

That is correct, and the reason is worth writing down rather than just fixing.
All three pitches varied *arrangement and palette* while treating the app as a
generic scheduler that happened to need styling. None of them asked what the
app is. The answer was sitting in the name the whole time: **Uncle Owen**, after
the picture of Uncle Owen on the Jedi Party Discord server this was built for.

So the direction is Tatooine — taken as palette, light and material, not as
decoration bolted onto a neutral app.

0008 is kept unedited, with its audit and its rejected alternatives. It is not
retro-fitted to pretend it proposed this.

## The two decisions that came with it

**1. The grid and the agenda both survive, as views you swap between.**

0008 framed pitch B (month grid) against pitch C (agenda list). The review
called that a false choice, and it was: the two answer different questions.
The grid answers *where is there a free evening?* The agenda answers *what is
next?* A scheduling app needs both, and picking one to delete was an artifact
of the pitch format rather than a real constraint.

Concretely: one route, one `GET /me/events` call, a `view` preference in local
storage, and a segmented control to flip it. This also **settles idea 20's
mobile question** — the hardest of its four open calls. Phones default to the
agenda, which already works in a single column, so there is no second layout to
design. That was the item idea 20's entry called "the real cost of the change";
it mostly evaporates.

**2. The theme lives in palette, material and incidental copy — not in the
navigation.**

Nav stays Calendar / Groups / Settings. Buttons say what they do. The
vernacular is allowed in atmosphere and in empty states ("Nothing on the
horizon"), never in a control someone needs to find. Renaming working controls
to in-jokes is the standard way a themed app becomes worse to use, and it is
the one move here that would trade usability for personality.

## The system

### Palette

The binary sunset is the token set, not a wallpaper. Two light sources give two
accents.

| Token | Light | Dark | Role |
|---|---|---|---|
| `ground` | `#EFE3CC` | `#1A1410` | Page. Bleached dune / warm black — no cold grey anywhere. |
| `surface` | `#F9F1E0` | `#241C16` | Cards, bars |
| `sunk` | `#E3D3B6` | `#120E0B` | Inset wells, code |
| `ink` | `#2A2018` | `#F0E2CC` | Body text |
| `muted` | `#6E5F4C` | `#A8927A` | Secondary text |
| `rule` | `#D6C4A4` | `#372B22` | Borders |
| `tatoo-i` | `#C4611E` | `#E8913A` | Primary accent — the larger, warmer sun |
| `tatoo-ii` | `#D99A2B` | `#F2C879` | Secondary accent — the smaller, paler sun |
| `dusk` | `#6B5378` | `#8B6BA0` | The violet band of the sunset |
| `moisture` | `#3E7F7F` | `#6FA8A8` | Vaporator teal — personal time |

Dusk violet and vaporator teal are what keep this from being a generic warm
palette. Teal earns its place semantically as well as visually: personal time
reads cool against warm group sessions, which is a real distinction the current
`PERSONAL_COLOR = bg-slate-600` makes only faintly.

**Group chips get a palette built for a warm ground** — rust `#A84E2E`, olive
`#6E7F3E`, brass `#C08A2A`, plum `#7A5488`, and four more — replacing the eight
Tailwind defaults in `lib/colors.ts`, which were picked against blue-black and
go muddy on sand. The FNV-1a hash and the stable-colour-per-group property in
that file do not change; only the swatch values do.

### Type

- **Saira Condensed** — display, section heads, buttons, nav. Condensed and
  slightly stencilled; reads as equipment labelling.
- **Barlow** — body and UI. Humanist with an industrial lineage, holds up small.
- **JetBrains Mono** — times, dates, counts. Tabular.

No serif, deliberately. A serif would read artisanal; this is used-future —
dusty and engineered rather than handcrafted.

### The signature: two suns, two shadows

Every raised surface casts **two** shadows — a hard warm one from Tatoo I and a
soft violet one from Tatoo II, at different angles:

```css
--lift:
   3px 4px 0 -2px rgba(196, 97, 30, .20),
  -2px 3px 10px -3px rgba(107, 83, 120, .30);
```

Two values in the token set, applied once. It is the one place the direction
spends boldness, and it is diegetic rather than decorative: the world this is
named after has two suns, so things in it are lit twice.

### Scenery: full homestead by default, twin suns in Settings

Decided by review. The dial stops being a design question and becomes a
preference someone can reach.

| Setting | What it is | |
|---|---|---|
| **Homestead** | Everything in *Twin suns*, plus: the binary-sunset wash behind the header, a sand-grain overlay on the ground, stencilled panel rules on section heads, and vaporators on the horizon at the foot of the landing page. | **Default** |
| **Twin suns** | Palette, type, the double shadow, and the two-circle mark. No wash, no grain, no scenery. | Settings → Scenery |

**The two are additive, and that is what makes this cheap.** *Twin suns* is
*Homestead* with the scenery removed — not a second design. Same tokens, same
type, same layout, same components; the toggle adds or removes one class on the
app root. There is no second visual system to maintain and no combinatorial
testing beyond "does each surface still read with the wash off".

Concretely, `Homestead` is a `data-scenery="homestead"` attribute on `<html>`
and a handful of rules keyed off it. Nothing else in the app branches on it.

The third position from the earlier draft — *atmosphere only*, no mark — drops
out. It existed to hedge on how far to commit, and that is now answered. With
the toggle built, adding it back is one more value in the same enum.

#### Three implementation calls this forces

**1. It must not flash.** If the preference is read from storage in React after
mount, everyone on *Twin suns* watches the homestead paint and then disappear,
on every load. So the choice is stamped onto `<html>` by a small inline script
in `index.html` before first paint — the same technique dark-mode toggles use:

```html
<script>
  try {
    var s = localStorage.getItem('uo.scenery');
    document.documentElement.dataset.scenery =
      s === 'twin-suns' ? 'twin-suns'
      : s === 'homestead' ? 'homestead'
      : matchMedia('(prefers-contrast: more)').matches ? 'twin-suns' : 'homestead';
  } catch (e) { document.documentElement.dataset.scenery = 'homestead'; }
</script>
```

Cheap, but invisible until it is missing, and the kind of thing that gets
discovered long after it should have been.

**2. It lives in local storage, not the database.** This keeps v0.4 free of a
migration entirely, which is worth something in a repo that has had three
schema-drift incidents in production (`SETUP.md`). The cost is honest: the
preference is per-device, so a phone and a laptop can disagree. `users` already
has a `timezone` column and a `scenery` beside it is a small change later if
that turns out to grate — see open question 3.

**3. Increased contrast flips the default, an explicit choice never.** The wash
and the grain are the parts that cost text contrast. If the OS asks for
increased contrast and the user has *not* chosen, the default resolves to *Twin
suns* (the `prefers-contrast` branch above). An explicit choice always beats the
inference, in both directions — the same precedence the theme tokens use.

#### What Homestead has to prove before it ships

It is the default, so it carries the burden, not the toggle:

- **Contrast with the wash on.** Header text and nav sit over a gradient running
  violet → rust → amber. Every state of that chrome has to clear 4.5:1 against
  the darkest and lightest points of the gradient, not just the middle.
- **The grain must not be an image.** It is an inline SVG `feTurbulence` data
  URI at ~5% opacity, `pointer-events: none`, behind content. No asset enters
  the build and it costs no request.
- **Body text never sits on the wash.** The gradient is confined to the header
  band and fades to the ground before content starts.

### One practical constraint

Drawn in the *idiom* — twin suns, desert light, weathered equipment — not from
any official asset: no film stills, no character art, and not the Star Wars
logotype, which is a trademark and a logo rather than a text face. Saira
Condensed does the same job and is licensed for it. Everything is CSS and
inline SVG; no image files enter the build.

## Motion

Added after review liked the horizon graphic and asked for "some light
animations". Companion motion study: the `Desert Weather` artifact.

**The rule.** This is a tool people open to answer a question and leave, so
animation that delights on visit one is irritating by visit four hundred.
Motion earns a place only if it (a) happens where there is no task, (b) replaces
something that already has to move, or (c) sits far enough in the periphery that
you only notice it when you look.

Four pieces qualify. All are CSS keyframes over inline SVG — no animation
library, no video, no image assets.

| # | Where | What moves | Repeats |
|---|---|---|---|
| 1 | `LoginPage.tsx` | Both suns descend and fade in, the warm glow builds, vaporators resolve, the sign-in block rises last (2.6s) | Never — once per session at most |
| 2 | The 7 `Loading…` strings | The smaller sun orbits the larger, swelling in front and dimming behind (1.9s) | While waiting |
| 3 | Empty states | **Nothing.** A drawn horizon and the line "Nothing on the horizon" | — |
| 4 | Landing page foot | A droplet falls from a vaporator bulb; two cycles at 9s and 12.5s so it never finds an anticipatable rhythm | Ambient, Homestead only |

**Piece 2 is the one that pays for itself.** A loading state has to signal
waiting regardless of appearance, so there is no patience cost — and it folds
seven ad-hoc `Loading…` strings (`AuthGuard`, `CalendarPage`, `GroupsPage`,
`EventDetailPage`, `PersonalEventPage`, `AdminUsersPage`, `DashboardPage`) into
one `<Loading />` primitive, a fifth alongside Button/Card/Field/PageHeader.
Worth doing as a simplification before any argument about how it looks.

**Piece 3 deliberately does not move.** An empty state is already a small
disappointment; animating it draws attention to the emptiness rather than to the
way out of it. The personality goes into the drawing and the copy, which a
screen reader can also read.

### Reduced motion is the default, not the fallback

Every animated element's normal CSS **is** its finished appearance; keyframes
supply only where it starts from, and the `animation` property is added inside
`@media (prefers-reduced-motion: no-preference)`.

That ordering is the whole correctness argument. The common bug is animating
*into* existence — `opacity: 0` in the base rule — so anyone who asks for reduced
motion gets a blank stage instead of a composed one. Built this way, turning
motion off can only remove movement, never content.

### Ruled out

- **Heat shimmer over the horizon.** Continuous distortion near text is a nausea
  risk, and it is the most expensive thing here to paint.
- **Event chips animating in as the calendar loads.** Staggered entry across up
  to 40 cells means the thing you came to read is still assembling when you look
  at it.
- **Page transitions between routes.** Latency on every navigation for novelty
  that expires in a week.
- **Sun position tracking real time of day.** Charming, and that is what loses
  it: the login hero is the only surface it would show on, and you see that
  screen about once.
- **Parallax dunes on scroll.** The landing page is a calendar; scroll-linked
  motion behind a grid of dates is noise.

### Cost, honestly

This is scope idea 8 did not name, though it sits inside "general polish". It
lands in branch 2 (identity). The loading primitive is a net simplification; the
login hero and empty state are roughly half a day between them, mostly drawing;
the drip is an hour and is the first thing to cut. None of it touches the
worker, the schema, or any data path, so all four delete cleanly if they do not
survive the sandbox.

## Sequencing: three branches, foundation first

The review's instinct was foundation-first, contingent on the direction. The
direction makes it firmer rather than softer: **a themed palette needs semantic
tokens more than a neutral one does.** Scattering `bg-amber-600` through 27
files is how a theme becomes unchangeable, and the dial above is only cheap if
every surface reads from a token.

1. **Foundation.** Semantic tokens in `tailwind.config.js`, four primitives
   (`Button`, `Card`, `Field`, `PageHeader`), focus-visible rings. Replaces 17
   card / 29 input / 10 button copies. No visual change. Also fixes the
   day-cell bug (idea 21), which every layout here forces anyway.
2. **Identity.** Point the tokens at the binary-sunset values; load the two
   faces; retune `lib/colors.ts`. Because step 1 landed, this is a small diff
   over a large surface — which is the entire reason to split them.
3. **View switch.** Month/agenda toggle, persisted, agenda as the mobile
   default; the merged landing page from idea 20; `/calendar` redirects to `/`.

The Scenery setting belongs to branch 2 (identity), along with the inline
pre-paint script and the Settings control. It is not a fourth branch: shipping
the identity without its own escape hatch would mean a window where the only
way out of the wash is a code change.

Each lands on the sandbox before `main`, per CLAUDE.md. Three round trips
rather than one, but each is a thing that can be looked at and judged on its
own.

## What idea 20's four open calls resolve to

| Call | Resolution |
|---|---|
| Sidebar follows the calendar, or anchored to now? | **Anchored to now** in month view (labelled "from today"). In agenda view the question dissolves — one range, one query. |
| Mobile | **Answered by the view switch.** Agenda is the phone default; no second layout to design. |
| `/`, `/calendar`, the nav | Merged view owns `/`; `/calendar` redirects rather than 404s; nav loses "Dashboard". |
| Header, action buttons, the `guilds.length === 0` state | Greeting cut — the horizon and the mark carry the warmth it was standing in for. Buttons top-right of the primary column. The empty state moves into the rail (month) or becomes the agenda's own empty state. |

## Out of scope

- **A user-facing light theme in v0.4.** The tokens above define one and the palette table
  carries its values, but shipping and reviewing both doubles the surface.
  Dark-first now, light flipped on when it can be looked at properly.
- **Raising the two-month ceiling** (idea 22). The agenda view *hides* it; it
  does not fix it. Still a behaviour change, still deferred.
- **The server noticeboard** (`0007`). Blocked on a Privacy Policy rewrite. The
  nav retains a slot for a server view; nothing is drawn.
- **Any worker change.** Idea 20 needs none. If this starts wanting one, the
  scope drifted.

## Open questions

1. **Eight-way group-colour distinguishability** was never verified on the old
   palette and is not yet verified on the new one. Worth checking against the
   real group list on the sandbox rather than in the abstract.
2. **Do the view and scenery preferences belong on the server?** Local storage
   is right for v0.4 — no schema change, no migration — but both are per-device,
   so a phone and a laptop can disagree. `users` already has a `timezone`
   column; `default_view` and `scenery` beside it are a small future change if
   it turns out to matter. Worth deciding together rather than one at a time.
3. **Does the agenda need its own range control** once it is the primary view
   on mobile, given idea 22's ceiling? Deliberately not answered here.

## Rejected alternatives

- **Picking one of 0008's three.** Rejected by review as insufficiently
  distinctive. Recorded there rather than re-argued here.
- **Choosing between the grid and the agenda.** A false choice — they answer
  different questions, and keeping both is what makes the mobile problem go
  away.
- **Theming the navigation** ("Tosche Station" for Settings, and so on). The
  reliable way to make a themed app worse to use. Note this does *not* extend to
  the Scenery setting's own option labels — "Homestead" and "Twin suns" are
  preference names rather than controls anyone needs to find under pressure, and
  each carries a plain one-line description beneath it.
- **Shipping Twin suns as the default and Homestead as opt-in.** The safer
  ordering, and rejected deliberately: almost nobody opens Settings to turn
  decoration *on*, so the app's actual identity would have been something most
  users never saw.
- **A light-first identity.** Tatooine daylight is the obvious pitch and the
  palette above supports it, but the app is dark today and its users arrive
  from Discord. Dark-first, light later.
- **Official Star Wars assets or the logotype.** Trademarked, and unnecessary —
  the idiom carries it.
