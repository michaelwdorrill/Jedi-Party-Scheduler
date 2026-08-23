// Which view the landing page opens in (spec 0009, idea 20).
//
// The two answer different questions and both survive: the grid answers "where
// is there a free evening", the agenda answers "what is next". Treating that as
// a choice between them was what made the original pitch a false dilemma.
//
// This is also what settles idea 20's mobile question. A rail beside a month
// grid does not fit a phone, and the entry called that "the real cost of the
// change" -- but the agenda already works in one column, so making it the phone
// default means there is no second layout to design at all.

export type CalendarView = 'month' | 'agenda';

export const VIEW_KEY = 'uo.view';

/** Below this, a month grid and a rail cannot sit side by side. */
export const AGENDA_BREAKPOINT = 900;

export function resolveView(stored: string | null, width: number): CalendarView {
  if (stored === 'month' || stored === 'agenda') return stored;
  return width < AGENDA_BREAKPOINT ? 'agenda' : 'month';
}

export function getView(): CalendarView {
  try {
    return resolveView(localStorage.getItem(VIEW_KEY), window.innerWidth);
  } catch {
    return 'month';
  }
}

export function setView(value: CalendarView): void {
  try {
    localStorage.setItem(VIEW_KEY, value);
  } catch {
    // Private mode. The choice holds for this page, it just will not survive a
    // reload -- which is the same trade the scenery setting makes.
  }
}
