# Specs

One file per unit of work that's about to be built. `../IDEAS.md` captures,
`../ROADMAP.md` orders, and these design.

A spec exists to answer the questions that would otherwise get answered
mid-implementation, badly and invisibly: what exactly changes for the user,
what the data model becomes, who is allowed to do it, what it costs the cron
tick, and how we know it works. If a spec has no open questions and no
rejected alternatives in it, it probably hasn't been thought about hard
enough yet.

## Convention

- Filename: `NNNN-short-slug.md`, numbered in the order specs are *written*,
  not the order they're built.
- Every spec names the `IDEAS.md` item(s) it covers and its roadmap phase, so
  the three files can't drift apart silently.
- Status line at the top: `Draft` (being written), `Ready` (agreed, safe to
  build from), `Built` (shipped — kept for the record, not updated further),
  or `Superseded by NNNN`.
- A spec is a plan, not a log. When the implementation deviates, the reason
  goes in the code or in `ARCHITECTURE.md`, which is what stays true; the
  spec is not retro-edited to pretend it predicted things.

## Index

| Spec | Covers | Phase | Status |
|---|---|---|---|
| [0001-quick-wins](0001-quick-wins.md) | Ideas 4, 12, 7, 11 | 0 | Built |
| [0002-sandbox-and-promotion](0002-sandbox-and-promotion.md) | Ideas 1, 14 | 1 | Ready |
| [0003-event-change-requests](0003-event-change-requests.md) | Idea 13 | 2 | Draft |
