// Scenery: how much desert the app carries (spec 0009).
//
// Two settings, additive rather than alternative -- `twin-suns` is `homestead`
// with the scenery removed, not a second design. Same tokens, same type, same
// layout; the toggle adds or removes one attribute on <html>.
//
// Homestead is the default, deliberately: almost nobody opens Settings to turn
// decoration *on*, so shipping the quiet one by default would have meant most
// people never saw the app's actual identity.

export type Scenery = 'homestead' | 'twin-suns';

export const SCENERY_KEY = 'uo.scenery';

/**
 * Resolves the setting the same way the pre-paint script in `index.html` does.
 * Kept in sync by hand -- that script cannot import from the bundle, because
 * its whole job is to run before the bundle exists.
 */
export function resolveScenery(stored: string | null): Scenery {
  if (stored === 'twin-suns' || stored === 'homestead') return stored;
  // The wash and the grain are the parts that cost text contrast, so someone
  // asking their OS for more contrast gets the quiet treatment by default.
  // An explicit choice always beats the inference, in both directions.
  return typeof matchMedia === 'function' && matchMedia('(prefers-contrast: more)').matches
    ? 'twin-suns'
    : 'homestead';
}

export function getScenery(): Scenery {
  try {
    return resolveScenery(localStorage.getItem(SCENERY_KEY));
  } catch {
    return 'homestead';
  }
}

export function setScenery(value: Scenery): void {
  document.documentElement.dataset.scenery = value;
  try {
    localStorage.setItem(SCENERY_KEY, value);
  } catch {
    // Private mode, or storage disabled. The attribute is already set, so the
    // choice holds for this page; it just will not survive a reload.
  }
}
