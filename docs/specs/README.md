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

| Spec | Covers | Phase | Ships in | Status |
|---|---|---|---|---|
| [0001-quick-wins](0001-quick-wins.md) | Ideas 4, 12, 7, 11 | 0 | 0.1 | Built |
| [0002-sandbox-and-promotion](0002-sandbox-and-promotion.md) | Ideas 1, 14 | 1 | 0.1 | Built |
| [0003-event-change-requests](0003-event-change-requests.md) | Idea 13 | 2 | 0.2 | Built |
| [0004-poll-datetime-consistency](0004-poll-datetime-consistency.md) | Idea 6 | 2 | 0.2 | Built |
| [0005-event-invite-links](0005-event-invite-links.md) | Idea 3 | 2 | 0.2 | Built |
| [0006-calendar-first](0006-calendar-first.md) | Idea 5 | 3 | 0.3 | Built |
| [0007-server-noticeboard](0007-server-noticeboard.md) | Idea 5 (second half) | TBD | TBD | Decisions locked |
| [0008-visual-design-pass](0008-visual-design-pass.md) | Ideas 8, 20 | 3.5 | 0.4 | Superseded by 0009 |
| [0009-binary-sunset](0009-binary-sunset.md) | Ideas 8, 20 | 3.5 | 0.4 | Ready |

This index had drifted: it stopped at 0003 while 0004–0007 existed, and
listed 0003 as Draft after it shipped. Keeping it current is cheap and it is
the only place the specs are listed together.
