// The fixed scene the whole app sits inside.
//
// Everything is anchored to the *viewport*, not the document, which is what
// makes the ground the bottom of the screen at any window size.
//
// Clouds and craft are Michael's silhouette art, cut out of the source sheet
// and recoloured into /public/sky (originals kept in /assets). They stay dark
// rather than being tinted, because a backlit cloud at sunset *is* a
// silhouette -- warm near-black, so they belong to the sand palette rather
// than sitting on top of it.
//
// Craft are positioned and translated in CSS `vw` rather than inside an SVG
// coordinate space, so their travel is in the same units as the screen and an
// offscreen start is expressible -- see the fill-mode note in index.css.
//
// Inert by construction: fixed, behind the content, pointer-events-none.

type Placed = {
  src: string;
  className: string;
  top: string;
  width: string;
  opacity: number;
};

// Cloud height is deliberately bounded to the middle and lower sky. High up the
// gradient is dark violet, where a dark silhouette is invisible; near the
// horizon it is bright, which is where backlit cloud actually reads. Putting
// them everywhere was what made the first attempt look like grey smudges.
const CLOUDS: Placed[] = [
  { src: 'cloud-bank-b', className: 'uo-cloud uo-cloud-1', top: '38%', width: 'min(38vw, 460px)', opacity: 0.5 },
  { src: 'cloud-wisp', className: 'uo-cloud uo-cloud-9', top: '43%', width: 'min(8vw, 90px)', opacity: 0.4 },
  { src: 'cloud-streak-b', className: 'uo-cloud uo-cloud-2', top: '46%', width: 'min(30vw, 340px)', opacity: 0.45 },
  { src: 'cloud-bank-c', className: 'uo-cloud uo-cloud-3', top: '52%', width: 'min(22vw, 250px)', opacity: 0.5 },
  { src: 'cloud-streak-a', className: 'uo-cloud uo-cloud-4', top: '58%', width: 'min(34vw, 400px)', opacity: 0.55 },
  { src: 'cloud-bank-a', className: 'uo-cloud uo-cloud-5', top: '63%', width: 'min(20vw, 230px)', opacity: 0.5 },
  { src: 'cloud-streak-e', className: 'uo-cloud uo-cloud-6', top: '68%', width: 'min(22vw, 250px)', opacity: 0.6 },
  { src: 'cloud-streak-c', className: 'uo-cloud uo-cloud-7', top: '72%', width: 'min(21vw, 240px)', opacity: 0.6 },
  { src: 'cloud-streak-d', className: 'uo-cloud uo-cloud-8', top: '76%', width: 'min(23vw, 250px)', opacity: 0.55 },
];

// Slower and higher reads as further away, so the Destroyer is the slowest
// thing up there despite being the largest. The TIE is a hexagon because a TIE
// in profile *is* a hexagon -- flat panels, near one facing you, ball hidden
// behind it -- and profile is the right angle for something crossing your view.
const CRAFT: Placed[] = [
  { src: 'star-destroyer', className: 'uo-craft uo-craft-destroyer', top: '13%', width: 'min(26vw, 300px)', opacity: 0.34 },
  { src: 'star-destroyer', className: 'uo-craft uo-craft-destroyer-2', top: '27%', width: 'min(13vw, 150px)', opacity: 0.2 },
  { src: 'x-wing', className: 'uo-craft uo-craft-xwing-a', top: '21%', width: '58px', opacity: 0.5 },
  { src: 'x-wing', className: 'uo-craft uo-craft-xwing-b', top: '24%', width: '48px', opacity: 0.45 },
  { src: 'x-wing', className: 'uo-craft uo-craft-xwing-c', top: '49%', width: '70px', opacity: 0.55 },
  { src: 'x-wing', className: 'uo-craft uo-craft-skimmer', top: '66%', width: '38px', opacity: 0.5 },
  { src: 'tie', className: 'uo-craft uo-craft-tie-a', top: '34%', width: '26px', opacity: 0.46 },
  { src: 'tie', className: 'uo-craft uo-craft-tie-b', top: '37%', width: '22px', opacity: 0.42 },
  { src: 'tie', className: 'uo-craft uo-craft-tie-c', top: '17%', width: '18px', opacity: 0.36 },
];

function Sprite({ src, className, top, width, opacity }: Placed) {
  return (
    <img
      src={`/sky/${src}.png`}
      alt=""
      decoding="async"
      className={className}
      style={{ top, width, opacity }}
    />
  );
}

export default function Sky() {
  return (
    <div className="uo-sky" aria-hidden="true">
      <div className="uo-sky-grad" />

      {/* The two suns drift independently -- they are different distances away,
          so tying them to one timing made them read as a painted backdrop. */}
      <div className="uo-sun uo-sun-i" />
      <div className="uo-sun uo-sun-ii" />

      {CLOUDS.map((c) => (
        <Sprite key={c.className} {...c} />
      ))}
      {CRAFT.map((c) => (
        <Sprite key={c.className} {...c} />
      ))}

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
