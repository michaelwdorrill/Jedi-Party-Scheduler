// Rebuilds src/lib/launchAnnouncementImage.ts from the frontend's copy of the
// 1.0 announcement picture, so the DM and the pop-up can never show different
// images. LAUNCH-ONLY: delete with the announcement in 1.1 (IDEAS item 105).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const image = readFileSync(`${root}frontend/public/announcements/uncle-owen-1.0.webp`).toString('base64');
const target = `${root}worker/src/lib/launchAnnouncementImage.ts`;
const current = readFileSync(target, 'utf8');
writeFileSync(target, current.replace(/'[A-Za-z0-9+/=]+';\n$/, `'${image}';\n`));
