import { describe, expect, it } from 'vitest';
import { editTargetReady, latestOnly } from '../src/lib/async';

// Pass-19 review, P19-03. EventFormPage loads an event into shared component
// state -- title, description, schedule, and crucially `loadedRevision` --
// while Save PATCHes whatever event the ROUTE currently names. With no
// obsolete-response guard, a late response for the event you were editing a
// moment ago repopulated all of it, and the next Save wrote those values over
// the event you had moved on to.
//
// The server could not catch it: two different events are legitimately both at
// revision 0, so the optimistic-concurrency check saw a well-formed request
// for the event it named. The association between loaded data and target
// identity had already been lost on the client.
//
// The mechanism to prevent it had existed in useAsync since it was written.
// EventFormPage predates that hook and hand rolled its own fetch, so it never
// got one -- which is the actual lesson: the same protection implemented twice
// is the same protection missing once. `latestOnly` is now the single copy,
// used by both, and this is the test it never had.
describe('latestOnly (P19-03)', () => {
  it('lets the only attempt through', () => {
    const gate = latestOnly();
    const isCurrent = gate.begin();
    expect(isCurrent()).toBe(true);
  });

  it('refuses an earlier attempt once a later one has begun', () => {
    const gate = latestOnly();
    const first = gate.begin();
    const second = gate.begin();

    // The exact shape of the bug: the FIRST request resolves last.
    expect(
      first(),
      'a response for the event the form was previously editing was allowed to write its state',
    ).toBe(false);
    expect(second()).toBe(true);
  });

  it('keeps refusing a superseded attempt however late it resolves', () => {
    const gate = latestOnly();
    const first = gate.begin();
    gate.begin();
    gate.begin();
    expect(first()).toBe(false);
  });

  it('is per gate, so two components do not cancel each other', () => {
    const a = latestOnly();
    const b = latestOnly();
    const aFirst = a.begin();
    b.begin();
    b.begin();
    expect(aFirst(), 'one page starting a request cancelled an unrelated one').toBe(true);
  });

  // The failure mode that matters for the form specifically: it is not enough
  // for the LAST response to win, the superseded one must write nothing at
  // all. A guard that let the stale response through and merely re-fetched
  // afterwards would still leave the wrong revision attached in between.
  it('models the form race end to end', () => {
    const gate = latestOnly();
    let title = '';
    let revision = -1;

    const applyEventA = gate.begin();
    const applyEventB = gate.begin();

    // B's response arrives first and is current.
    if (applyEventB()) {
      title = 'Event B';
      revision = 0;
    }
    // A's response arrives late. Before the guard, this overwrote both.
    if (applyEventA()) {
      title = 'Event A';
      revision = 0;
    }

    expect(title).toBe('Event B');
    expect(revision).toBe(0);
  });
});

// Pass-20 review (P20-01), the residual half of P19-03. `latestOnly` stopped an
// obsolete response overwriting newer state -- the reported bug. It never
// touched the opposite order: while a newly selected event is still loading,
// the fields and the loaded revision still belong to the PREVIOUS event, and
// Save was enabled and submitted them to the current route's id. Two events are
// legitimately both at revision 0, so the server accepted a well-formed request
// the client had assembled wrongly, and one event's contents landed on another.
describe('editTargetReady (P20-01)', () => {
  it('blocks a save while a different event is still loading', () => {
    expect(
      editTargetReady({ isEdit: true, loadedId: 'evt-a', targetId: 'evt-b' }),
      "event A's fields were submittable to event B",
    ).toBe(false);
  });

  it('blocks a save before anything has loaded', () => {
    expect(editTargetReady({ isEdit: true, loadedId: null, targetId: 'evt-b' })).toBe(false);
  });

  it('allows a save once the loaded event is the target', () => {
    expect(editTargetReady({ isEdit: true, loadedId: 'evt-b', targetId: 'evt-b' })).toBe(true);
  });

  // A creation form has nothing loaded and must not be blocked by a rule about
  // loaded state -- getting this wrong would break every new event instead.
  it('never blocks event creation', () => {
    expect(editTargetReady({ isEdit: false, loadedId: null, targetId: undefined })).toBe(true);
  });

  it('blocks an edit with no target id rather than defaulting to allowed', () => {
    expect(editTargetReady({ isEdit: true, loadedId: null, targetId: undefined })).toBe(false);
  });
});
