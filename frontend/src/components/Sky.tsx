// The fixed scene the whole app sits inside.
//
// Everything is anchored to the *viewport*, not the document, which is what
// makes the ground the bottom of the screen at any window size.
//
// Traffic is positioned by CSS rather than inside the SVG coordinate space:
// each craft is an absolutely-placed element translated in `vw`, so its travel
// is in the same units as the screen and does not have to survive the viewBox
// mapping. That also makes an offscreen start expressible, which matters --
// see the note on fill-mode in index.css.
//
// Inert by construction: fixed, behind the content, pointer-events-none.

type CraftProps = { className: string; top: string; scale?: number };

function StarDestroyer({ className, top, scale = 1 }: CraftProps) {
  return (
    <div className={className} style={{ top, width: `${300 * scale}px` }}>
      <svg viewBox="0 0 300 44" className="w-full" fill="#120C08" opacity="0.34">
        <path d="M2 30 L232 6 L296 20 L232 34 Z" />
        <path d="M150 14 L214 7 L224 12 L160 19 Z" opacity="0.75" />
        <rect x="196" y="8" width="7" height="4" rx="1" opacity="0.9" />
      </svg>
    </div>
  );
}

function Freighter({ className, top, scale = 1 }: CraftProps) {
  return (
    <div className={className} style={{ top, width: `${86 * scale}px` }}>
      <svg viewBox="0 0 86 30" className="w-full" fill="#140D08" opacity="0.42">
        <ellipse cx="40" cy="16" rx="34" ry="10" />
        <path d="M60 10 L86 13 L86 19 L60 22 Z" />
        <rect x="24" y="3" width="26" height="6" rx="3" />
      </svg>
    </div>
  );
}

function XWing({ className, top, scale = 1 }: CraftProps) {
  return (
    <div className={className} style={{ top, width: `${52 * scale}px` }}>
      <svg viewBox="0 0 52 26" className="w-full" fill="#170F0A" opacity="0.5">
        <path d="M2 13 L34 10 L48 13 L34 16 Z" />
        <path d="M12 11 L42 2 L45 5 L18 12 Z" />
        <path d="M12 15 L42 24 L45 21 L18 14 Z" />
        <path d="M10 10 L36 4 L38 7 L14 12 Z" />
        <path d="M10 16 L36 22 L38 19 L14 14 Z" />
      </svg>
    </div>
  );
}

function Tie({ className, top, scale = 1 }: CraftProps) {
  return (
    <div className={className} style={{ top, width: `${34 * scale}px` }}>
      <svg viewBox="0 0 34 30" className="w-full" fill="#150E09" opacity="0.46">
        <path d="M2 3 L8 8 L8 22 L2 27 Z" />
        <path d="M32 3 L26 8 L26 22 L32 27 Z" />
        <rect x="8" y="13" width="18" height="4" />
        <circle cx="17" cy="15" r="6" />
      </svg>
    </div>
  );
}

export default function Sky() {
  return (
    <div className="uo-sky" aria-hidden="true">
      <div className="uo-sky-grad" />

      {/* The two suns drift independently -- they are different distances away,
          so tying them to one layer made them read as a painted backdrop. */}
      <div className="uo-sun uo-sun-i" />
      <div className="uo-sun uo-sun-ii" />

      {/* Dust haze, not cloud. Tatooine has no weather to speak of; these are
          thin bands catching the low light, kept near the horizon where the
          warmth is. The previous version put fat ellipses high in the dark part
          of the sky, where they read as grey smudges. */}
      <svg className="uo-haze" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <g fill="#F2C879">
          <rect x="60" y="470" width="420" height="2" rx="1" opacity="0.10" />
          <rect x="180" y="486" width="260" height="1.5" rx="1" opacity="0.07" />
          <rect x="540" y="452" width="360" height="2" rx="1" opacity="0.08" />
          <rect x="620" y="500" width="300" height="1.5" rx="1" opacity="0.06" />
          <rect x="300" y="518" width="480" height="2" rx="1" opacity="0.05" />
        </g>
      </svg>

      {/* Traffic. Slower and higher reads as further away, so the Destroyer is
          the slowest thing up there despite being the largest. */}
      <StarDestroyer className="uo-craft uo-craft-destroyer" top="14%" />
      <Freighter className="uo-craft uo-craft-freighter" top="30%" />
      <XWing className="uo-craft uo-craft-xwing-a" top="22%" />
      <XWing className="uo-craft uo-craft-xwing-b" top="25%" scale={0.86} />
      <XWing className="uo-craft uo-craft-xwing-c" top="45%" scale={1.2} />
      <Tie className="uo-craft uo-craft-tie-a" top="36%" />
      <Tie className="uo-craft uo-craft-tie-b" top="39%" scale={0.82} />
      <Tie className="uo-craft uo-craft-tie-c" top="18%" scale={0.7} />
      <XWing className="uo-craft uo-craft-skimmer" top="63%" scale={0.6} />

      {/* The ground, pinned to the bottom edge at every window size. */}
      <svg className="uo-ground" viewBox="0 0 1000 150" preserveAspectRatio="none">
        <path
          d="M0 44 C 160 24, 340 40, 520 32 C 700 24, 860 42, 1000 34 L1000 150 L0 150 Z"
          fill="#170F0A"
        />
        <path
          d="M0 66 C 200 52, 420 64, 640 56 C 820 50, 920 62, 1000 58 L1000 150 L0 150 Z"
          fill="#120B07"
        />
      </svg>

      {/* Vaporators standing on that ground, with condensate. */}
      <svg className="uo-vaporators" viewBox="0 0 1000 120" preserveAspectRatio="none">
        <g fill="#0D0805">
          <rect x="118" y="34" width="4" height="86" />
          <ellipse cx="120" cy="32" rx="8.5" ry="10" />
          <rect x="158" y="52" width="3" height="68" />
          <ellipse cx="159.5" cy="50" rx="6" ry="7.5" />
          <rect x="842" y="44" width="3.6" height="76" />
          <ellipse cx="844" cy="42" rx="7.5" ry="9" />
        </g>
        <circle className="uo-drop-a" cx="120" cy="42" r="2.6" fill="#6FA8A8" opacity="0" />
        <circle className="uo-drop-b" cx="844" cy="52" r="2.3" fill="#6FA8A8" opacity="0" />
      </svg>
    </div>
  );
}
