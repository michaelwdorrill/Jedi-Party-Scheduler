# Source art

The originals for the sky scene (`frontend/src/components/Sky.tsx`). Kept here
rather than in `frontend/public` so the repo holds the source and the bundle
holds only what ships.

| File | What it is |
|---|---|
| `clouds.png` | A sheet of ~20 cloud silhouettes, black on white, no alpha |
| `stardestroyer.png` | Star Destroyer in profile, black on transparent |
| `Xwing.png` | X-wing in profile, black on transparent |
| `tie.png` | TIE fighter in profile — a hexagon, which is correct: the panels are flat planes, so from the side the near one faces you and hides the ball and the far panel behind it |

## What ships

`frontend/public/sky/` holds the processed versions: individual clouds cut out
of the sheet, white made transparent, and everything recoloured to a warm
near-black (`#17100A` for cloud, `#140D08` for craft) so the silhouettes belong
to the sand palette instead of sitting on it as pure black.

They stay dark rather than tinted amber because a backlit cloud at sunset *is*
a silhouette — tinting them to the light would be the wrong way round.

Twelve files, 68 KB total. To recut after changing a source file, the
segmentation is a connected-components pass over `clouds.png` filtered to blobs
over 220px; the picks and their names are listed in `Sky.tsx`.
