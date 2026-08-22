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

### How far the theme goes — the one open call

A dial, not a fork; the token set is identical at all three settings, so moving
later is cheap.

| Setting | What it adds | Trade |
|---|---|---|
| 1 · Atmosphere only | Palette, type, double shadow. No imagery. | A stranger wouldn't clock the reference. |
| **2 · Twin-sun mark** *(recommended)* | Two-circle logo mark; horizon-with-vaporators on the login page and empty states. | Present, never in the way. |
| 3 · Full homestead | Sunset wash behind the header, sand-grain texture, stencilled panel labels. | Most characterful; most likely to wear thin by the four-hundredth visit. |

### One practical constraint

Drawn in the *idiom* — twin suns, desert light, weathered equipment — not from
any official asset: no film stills, no character art, and not the Star Wars
logotype, which is a trademark and a logo rather than a text face. Saira
Condensed does the same job and is licensed for it. Everything is CSS and
inline SVG; no image files enter the build.

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

- **A light theme in v0.4.** The tokens above define one and the palette table
  carries its values, but shipping and reviewing both doubles the surface.
  Dark-first now, light flipped on when it can be looked at properly.
- **Raising the two-month ceiling** (idea 22). The agenda view *hides* it; it
  does not fix it. Still a behaviour change, still deferred.
- **The server noticeboard** (`0007`). Blocked on a Privacy Policy rewrite. The
  nav retains a slot for a server view; nothing is drawn.
- **Any worker change.** Idea 20 needs none. If this starts wanting one, the
  scope drifted.

## Open questions

1. **Theme intensity** — setting 1, 2 or 3. Recommended: 2.
2. **Eight-way group-colour distinguishability** was never verified on the old
   palette and is not yet verified on the new one. Worth checking against the
   real group list on the sandbox rather than in the abstract.
3. **Does the view preference belong on the server?** Local storage is right
   for v0.4 — no schema change, no migration — but it means the preference
   doesn't follow you between devices. `users` already has a `timezone` column;
   a `default_view` beside it is a small future change if it turns out to
   matter.
4. **Does the agenda need its own range control** once it is the primary view
   on mobile, given idea 22's ceiling? Deliberately not answered here.

## Rejected alternatives

- **Picking one of 0008's three.** Rejected by review as insufficiently
  distinctive. Recorded there rather than re-argued here.
- **Choosing between the grid and the agenda.** A false choice — they answer
  different questions, and keeping both is what makes the mobile problem go
  away.
- **Theming the navigation** ("Tosche Station" for Settings, and so on). The
  reliable way to make a themed app worse to use.
- **A light-first identity.** Tatooine daylight is the obvious pitch and the
  palette above supports it, but the app is dark today and its users arrive
  from Discord. Dark-first, light later.
- **Official Star Wars assets or the logotype.** Trademarked, and unnecessary —
  the idiom carries it.
