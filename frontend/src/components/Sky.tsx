// The fixed scene the whole app sits inside.
//
// Everything here is anchored to the *viewport*, not to the document, which is
// what makes the ground the bottom of the screen at any window size. The
// previous version put the vaporators in normal flow after the footer, so on a
// short page they hung in mid-air with nothing under them -- they were part of
// the page when they should have been part of the world.
//
// Layers move at different speeds so the depth reads: the suns are effectively
// fixed, clouds drift, and the ships cross fastest because they are nearest.
// Nothing here is scroll-linked -- most pages in this app do not scroll, so
// scroll parallax would simply never fire.
//
// Inert by construction: fixed, behind the content, and pointer-events-none, so
// it can never intercept a click.
export default function Sky() {
  return (
    <div className="uo-sky" aria-hidden="true">
      <div className="uo-sky-grad" />

      {/* Tatoo I and II. The anchor of the scene, so they barely move. */}
      <svg className="uo-layer uo-layer-suns" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <circle cx="672" cy="556" r="74" fill="#E8913A" opacity="0.5" />
        <circle cx="774" cy="590" r="34" fill="#F2C879" opacity="0.42" />
      </svg>

      {/* High cloud. Tatooine is a desert world, so this is thin haze rather
          than cumulus -- long, flat, and barely there. */}
      <svg className="uo-layer uo-layer-cloud" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <g fill="#F2C879" opacity="0.06">
          <ellipse cx="220" cy="300" rx="150" ry="9" />
          <ellipse cx="300" cy="322" rx="90" ry="6" />
          <ellipse cx="760" cy="262" rx="120" ry="7" />
        </g>
      </svg>

      {/* Traffic. Each crosses, then waits offscreen for most of its cycle, so
          the sky is usually empty and a crossing is something you happen to
          catch rather than a loop you learn. Drawn in silhouette and in the
          idiom -- no traced artwork. */}
      <svg className="uo-layer uo-layer-far" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <g className="uo-ship-destroyer" fill="#120C08" opacity="0.30">
          <path d="M0 214 L150 190 L196 200 L150 210 Z" />
          <path d="M96 196 L134 191 L140 196 L104 200 Z" opacity="0.7" />
        </g>
      </svg>

      <svg className="uo-layer uo-layer-mid" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <g className="uo-ship-tie" fill="#150E09" opacity="0.42">
          <rect x="0" y="336" width="3" height="26" />
          <rect x="13" y="336" width="3" height="26" />
          <rect x="3" y="346" width="10" height="6" />
          <circle cx="8" cy="349" r="4.6" />
        </g>
      </svg>

      <svg className="uo-layer uo-layer-near" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMax slice">
        <g className="uo-ship-xwing" fill="#170F0A" opacity="0.5">
          <path d="M0 424 L26 421 L34 424 L26 427 Z" />
          <path d="M8 422 L30 412 L32 414 L12 423 Z" />
          <path d="M8 426 L30 436 L32 434 L12 425 Z" />
          <path d="M6 421 L26 414 L27 416 L9 422 Z" />
          <path d="M6 427 L26 434 L27 432 L9 426 Z" />
        </g>
      </svg>

      {/* The ground. Anchored to the bottom edge at every window size -- this is
          the whole point of the scene being fixed. */}
      <svg
        className="uo-ground"
        viewBox="0 0 1000 150"
        preserveAspectRatio="none"
      >
        <path d="M0 44 C 160 24, 340 40, 520 32 C 700 24, 860 42, 1000 34 L1000 150 L0 150 Z" fill="#170F0A" />
        <path d="M0 66 C 200 52, 420 64, 640 56 C 820 50, 920 62, 1000 58 L1000 150 L0 150 Z" fill="#120B07" />
      </svg>

      {/* Vaporators standing on that ground, with condensate. They belong to the
          world now, not to the footer. */}
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
