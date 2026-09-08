/** Stand-in for api.js: records calls, returns urls, never touches the network. */
export const calls = { song: [], lyrics: [] };
export let songDelayMs = 0;
export function setSongDelay(ms) { songDelayMs = ms; }
export function reset() { calls.song = []; calls.lyrics = []; songDelayMs = 0; }

export const QUALITY = [{ level: 'auto', bft: null, name: '自动' }];
export const BYTES_PER_MIN = { standard: 1e6 };
export const SOURCE_NAME = { 163: 'NetEase' };
export const sourceOf = () => '163';
export const forceOf = () => 5;
export const labelOf = (l) => `label:${l}`;
export const resolveQuality = (l) => (l === 'auto' ? 'lossless' : l);
export const isApiUrl = (u) => String(u).includes('/api/');
export const withToken = (u) => String(u);
export const coverUrl = (u) => String(u || '');
export const parseLyrics = () => [];
export const lyricIndexAt = () => -1;
export function setUnauthorizedHandler() {}
export function memberToken() { return ''; }

export async function song(id, level) {
  calls.song.push({ id: String(id), level, at: Date.now() });
  if (songDelayMs) await new Promise((r) => setTimeout(r, songDelayMs));
  return { id, url: `https://cdn.test/${id}.mp3`, level: 'lossless', levelLabel: 'LOSSLESS · 库', lyric: '' };
}
export async function lyrics(id) { calls.lyrics.push(String(id)); return []; }
