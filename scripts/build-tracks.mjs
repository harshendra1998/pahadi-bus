/* Scrapes a public YouTube playlist page into tracks.json.
   Usage: node scripts/build-tracks.mjs <playlist-url-or-id>
   YouTube ships the whole list inside ytInitialData on the HTML page, so no
   API key and no deps — just parse the blobs we need out of it. */

import { writeFileSync } from 'node:fs';

const arg = process.argv[2] || 'PLeatb7hupNV_AWUl_7ttbsKeCQh8tF5N4';
const list = arg.includes('list=') ? new URL(arg).searchParams.get('list') : arg;

const html = await fetch(`https://www.youtube.com/playlist?list=${list}`, {
  headers: { 'accept-language': 'en' },
}).then((r) => r.text());

/* Titles carry the whole SEO tail — "Song | Movie | Cast | Singers, 90s Hits".
   Everything before the first pipe/bracket is the song. */
const clean = (raw) =>
  raw
    .split(/[|(\[]/)[0]
    .replace(/\b(full )?(hd |4k )?(video )?(song|audio)s?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim() || raw.trim();

const tracks = [];
const seen = new Set();

for (const chunk of html.split('"lockupViewModel":{').slice(1)) {
  const id = chunk.match(/\/vi\/([A-Za-z0-9_-]{11})\//)?.[1];
  const rawTitle = chunk.match(/"lockupMetadataViewModel":\{"title":\{"content":"(.*?)"/)?.[1];
  if (!id || !rawTitle || seen.has(id)) continue;
  seen.add(id);

  const title = JSON.parse(`"${rawTitle}"`);
  const artist = chunk.match(/"a11yLabel":"Go to channel (.*?)"/)?.[1] ?? '';

  tracks.push({
    id,
    title: clean(title),
    artist: JSON.parse(`"${artist}"`),
    cover: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    rawTitle: title,
  });
}

if (!tracks.length) throw new Error('No tracks found — is the playlist public?');

writeFileSync(new URL('../tracks.json', import.meta.url), JSON.stringify(tracks, null, 2));
console.log(`${tracks.length} tracks → tracks.json`);
