/**
 * The soundtrack (src/data/audio.json): one long-lived player shared by every
 * scene, so a track flows on across scene changes and never restarts.
 *
 * Built directly on Phaser's Web Audio context, below the sound manager:
 *   - Gapless looping: each track's trailing silence (both files end in
 *     ~1.5 s of it) is measured from the decoded audio and cut, and the next
 *     pass is scheduled `crossfade` seconds before the end, under the
 *     outgoing tail, so there is never a silent gap at the loop.
 *   - Fades are sample-accurate gain ramps on the audio clock.
 *   - Volume = master x music settings, live; routed through Phaser's master
 *     node, so `game.sound.mute` silences it too.
 *   - The context starts locked (browser autoplay policy); Phaser unlocks it
 *     on the first click / key, and the music starts then.
 */

import Phaser from 'phaser';
import audio from '@/data/audio.json';
import { settings } from '@/systems/SettingsManager';

type TrackId = keyof typeof audio.tracks;
interface TrackDef { file: string; crossfade: number; volume: number }
const TRACKS = audio.tracks as Record<TrackId, TrackDef>;
const SCENES = audio.scenes as Record<string, TrackId>;
export const FADES = audio.fades;

const key = (id: string) => `music:${id}`;
const SCHEDULE_AHEAD = 1.5;          // seconds of passes queued ahead of the clock

interface Playing {
  id: TrackId;
  gain: GainNode;                     // the track's fade gain
  sources: AudioBufferSourceNode[];
  nextStart: number;                  // audio-clock time of the next pass
  loopStart: number; loopEnd: number; // trimmed region of the buffer, s
  buffer: AudioBuffer;
}

class MusicPlayer {
  private game?: Phaser.Game;
  private ctx?: AudioContext;
  private bus?: GainNode;             // master x music volume
  private current: Playing | null = null;
  private fading: Playing[] = [];
  private timer = 0;
  private pendingId: TrackId | null = null;
  private pendingFade = 0;

  /** Queue both tracks. Call from Boot's preload(). */
  preload(scene: Phaser.Scene): void {
    for (const [id, t] of Object.entries(TRACKS)) if (!scene.cache.audio.exists(key(id))) scene.load.audio(key(id), t.file);
  }

  install(game: Phaser.Game): void {
    if (this.game) return;
    this.game = game;
    const sm = game.sound;
    if (!(sm instanceof Phaser.Sound.WebAudioSoundManager)) return;     // no Web Audio: no music
    this.ctx = sm.context;
    this.bus = this.ctx.createGain();
    this.bus.connect(sm.destination);
    this.applyVolume(true);
    settings.subscribe(() => this.applyVolume(false));
    // Schedule passes ahead of the clock; runs whether or not a scene ticks.
    this.timer = window.setInterval(() => this.pump(), 250);
    // Belt and braces: resume on the first gesture even if Phaser hasn't yet.
    const resume = () => { void this.ctx?.resume(); };
    window.addEventListener('pointerdown', resume, { once: true, capture: true });
    window.addEventListener('keydown', resume, { once: true, capture: true });
  }

  /** Start the track mapped to this scene (no-op if it's already playing). */
  forScene(sceneKey: string, fadeIn?: number): void {
    const id = SCENES[sceneKey];
    if (id) this.play(id, { fadeIn: fadeIn ?? (this.current ? FADES.switch : 0) });
  }

  /**
   * Make `id` the current track. Already current → nothing (it keeps flowing).
   * Otherwise the current track fades out and `id` fades in; `restart`
   * starts `id` from its beginning even if it is already playing.
   */
  play(id: TrackId, o: { fadeIn?: number; fadeOut?: number; restart?: boolean } = {}): void {
    if (!this.ctx || !this.bus) return;
    if (this.current?.id === id && !o.restart) return;
    const buffer = this.game!.cache.audio.get(key(id)) as AudioBuffer | undefined;
    if (!buffer) { this.pendingId = id; this.pendingFade = o.fadeIn ?? 0; return; }
    if (this.current) this.fadeOut(o.fadeOut ?? FADES.switch);
    const now = this.ctx.currentTime;
    const gain = this.ctx.createGain();
    gain.connect(this.bus);
    const vol = TRACKS[id].volume;
    const fadeIn = o.fadeIn ?? 0;
    if (fadeIn > 0) ramp(gain.gain, 0, vol, now, fadeIn);
    else gain.gain.setValueAtTime(vol, now);
    const { start, end } = trim(buffer);
    this.current = { id, gain, sources: [], nextStart: now + 0.05, loopStart: start, loopEnd: end, buffer };
    this.pendingId = null;
    this.pump();
  }

  /** Fade the current track out (it stops when silent). */
  fadeOut(seconds: number): void {
    const c = this.current;
    if (!c || !this.ctx) return;
    this.current = null;
    const now = this.ctx.currentTime;
    const g = c.gain.gain;
    const from = g.value;
    g.cancelScheduledValues(now);
    ramp(g, from, 0, now, Math.max(0.05, seconds));
    this.fading.push(c);
    window.setTimeout(() => {
      c.sources.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
      c.gain.disconnect();
      this.fading = this.fading.filter((f) => f !== c);
    }, (seconds + 0.2) * 1000);
  }

  get currentTrack(): TrackId | null { return this.current?.id ?? null; }

  /** Dev probe: what's audible right now. */
  debugState(): Record<string, unknown> {
    return {
      ctx: this.ctx?.state, time: this.ctx?.currentTime,
      current: this.current && { id: this.current.id, gain: this.current.gain.gain.value, passes: this.current.sources.length, loop: [this.current.loopStart, this.current.loopEnd] },
      fading: this.fading.map((f) => ({ id: f.id, gain: f.gain.gain.value })),
      bus: this.bus?.gain.value,
    };
  }

  private pump(): void {
    if (this.pendingId && this.game?.cache.audio.exists(key(this.pendingId))) this.play(this.pendingId, { fadeIn: this.pendingFade });
    const c = this.current;
    if (!c || !this.ctx) return;
    // While the context is locked the clock stands still: queue one pass only.
    while (c.nextStart < this.ctx.currentTime + SCHEDULE_AHEAD && (this.ctx.state === 'running' || c.sources.length === 0)) {
      const src = this.ctx.createBufferSource();
      src.buffer = c.buffer;
      // A short fade on each pass's own gain avoids a click at its start.
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, c.nextStart);
      g.gain.linearRampToValueAtTime(1, c.nextStart + 0.03);
      src.connect(g).connect(c.gain);
      const dur = c.loopEnd - c.loopStart;
      src.start(c.nextStart, c.loopStart, dur);
      src.onended = () => { c.sources = c.sources.filter((s) => s !== src); g.disconnect(); };
      c.sources.push(src);
      // The next pass starts under this one's fading tail.
      c.nextStart += Math.max(1, dur - TRACKS[c.id].crossfade);
    }
  }

  private applyVolume(instant: boolean): void {
    if (!this.bus || !this.ctx) return;
    const v = (settings.get('masterVolume') / 100) * (settings.get('musicVolume') / 100);
    const now = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(now);
    if (instant) this.bus.gain.setValueAtTime(v, now);
    else this.bus.gain.setTargetAtTime(v, now, 0.05);    // smooth slider drags
  }

  destroy(): void { window.clearInterval(this.timer); }
}

/**
 * An equal-power fade (quarter-sine in the gain domain): perceived loudness
 * changes evenly, unlike an exponential ramp, which lingers near silence.
 */
function ramp(p: AudioParam, from: number, to: number, at: number, seconds: number): void {
  const n = 64, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const k = to > from ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
    curve[i] = to > from ? from + (to - from) * k : to + (from - to) * k;
  }
  p.setValueCurveAtTime(curve, at, seconds);
}

/** Audible region of a buffer: skips leading and trailing digital silence. */
const trimCache = new WeakMap<AudioBuffer, { start: number; end: number }>();
function trim(b: AudioBuffer): { start: number; end: number } {
  const hit = trimCache.get(b);
  if (hit) return hit;
  const thr = 0.0015, chans = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  const loud = (i: number) => chans.some((c) => Math.abs(c[i]) > thr);
  let s = 0; while (s < b.length - 1 && !loud(s)) s++;
  let e = b.length - 1; while (e > s && !loud(e)) e--;
  const r = { start: s / b.sampleRate, end: (e + 1) / b.sampleRate };
  trimCache.set(b, r);
  return r;
}

export const music = new MusicPlayer();
