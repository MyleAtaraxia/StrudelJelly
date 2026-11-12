import { getAudioContext, superdough, soundMap, getCachedBuffer } from '@strudel/webaudio';

// Auditioning helpers for the sound browser. strudel.js stays untouched.
const ready = new Set(); // "name:n" of sounds already downloaded this session
let token = 0;

// url of variation n of a sample sound, or undefined
function sampleUrl(name, n = 0) {
  const s = soundMap.get()[name]?.data?.samples;
  const list = Array.isArray(s) ? s : s ? Object.values(s)[0] : null;
  if (!list?.length) return undefined;
  const url = list[((n % list.length) + list.length) % list.length];
  return typeof url === 'string' ? url.replace('#', '%23') : undefined;
}

// length in seconds when the buffer is already decoded (never downloads anything)
export function lengthOf(name, n = 0) {
  const url = sampleUrl(name, n);
  return url ? getCachedBuffer(url)?.duration : undefined;
}

export function fmtLen(sec) {
  if (!(sec > 0)) return '';
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  if (sec < 10) return `${sec.toFixed(1)}s`;
  if (sec < 60) return `${Math.round(sec)}s`;
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

// samples play variation n; everything else plays a short c3 note
export async function audition(name, { n = 0, type = 'synth' } = {}) {
  const mine = ++token;
  const ac = getAudioContext();
  if (ac.state !== 'running') await ac.resume();
  const isSample = type === 'sample';
  const value = isSample ? { s: name, n } : { s: name, note: 'c3', clip: 1 };
  const key = `${name}:${n}`;
  if (!ready.has(key)) {
    // a silent hit waits for the download, so the audible one starts on time
    await superdough({ ...value, gain: 0 }, ac.currentTime + 0.02, 0.01);
    ready.add(key);
    if (mine !== token) return; // a newer audition replaced this one while it downloaded
  }
  await superdough({ ...value, gain: 0.8 }, ac.currentTime + 0.03, isSample ? 1.5 : 0.7);
}
