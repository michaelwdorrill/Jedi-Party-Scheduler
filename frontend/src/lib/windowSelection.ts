// Dragging one end of a window selection, with the other end getting out of
// the way.
//
// The first version clamped instead: moving "earliest you could start" past
// `end - blockMinutes` simply refused, and the handle stopped dead under the
// cursor with nothing on screen saying why. That reads as a broken control
// rather than as a rule -- the rule is real (a selection shorter than the
// minimum can never win) but a slider that stops moving is the worst
// possible way to state it.
//
// So the other end moves instead: start 6:00-8:30 with a 2.5-hour minimum,
// drag the start to 6:30, and the end follows to 9:00. This is the same
// convention `handleStartDateChange` already uses on the event form, where
// moving a start date forward drags an earlier end date along with it.
//
// Symmetric on purpose. Michael hit it dragging the start, but the end
// handle had exactly the same dead zone, and a rule that applies to one
// handle and not the other is harder to learn than either behaviour alone.
//
// Minutes throughout, measured from the window's own start, which is what
// the range inputs bind to.
export interface WindowSelection {
  startMin: number;
  endMin: number;
}

// Both ends stay inside [0, totalMin], so a push can never carry the
// selection past the window it lives in. That does mean the dragged end
// stops once the pushed one hits the wall -- but by then the selection
// really has nowhere left to go, which is a different thing from stopping
// halfway through the window.
export function moveWindowStart(
  next: number,
  current: WindowSelection,
  totalMin: number,
  blockMin: number,
): WindowSelection {
  const startMin = Math.min(Math.max(next, 0), Math.max(0, totalMin - blockMin));
  return { startMin, endMin: Math.min(totalMin, Math.max(current.endMin, startMin + blockMin)) };
}

export function moveWindowEnd(
  next: number,
  current: WindowSelection,
  totalMin: number,
  blockMin: number,
): WindowSelection {
  const endMin = Math.max(Math.min(next, totalMin), Math.min(totalMin, blockMin));
  return { startMin: Math.max(0, Math.min(current.startMin, endMin - blockMin)), endMin };
}
