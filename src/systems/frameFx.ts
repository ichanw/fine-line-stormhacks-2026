/**
 * FrameFX — a PostFX pass for the user's flattened story frames.
 *
 *   boil     line boil on raster art: every pixel is moved by a WHOLE device
 *            pixel along a smooth noise field that steps between 3 variants
 *            at ~4 fps (scenery rate). Whole-pixel moves never resample, so the
 *            pencil stays exactly as sharp as the source.
 *   shimmer  heat haze (bad outcome): a rising wavy displacement, strongest
 *            near the ground.
 *   dim      darkens the picture (bad outcome).
 *
 * Done on the GPU because the frames are 2880x2048: three CPU-displaced copies
 * of each would cost ~70 MB of textures and a visible stall per scene.
 */

import Phaser from 'phaser';
import { BOIL_FPS_SCENERY } from '@/systems/constants';
import { settings } from '@/systems/SettingsManager';

const FRAG = `
#define SHADER_NAME FRAME_FX
precision highp float;
uniform sampler2D uMainSampler;
uniform vec2 uResolution;
uniform float uPhase;
uniform float uBoil;
uniform float uShimmer;
uniform float uTime;
uniform float uDim;
varying vec2 outTexCoord;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y) * 2.0 - 1.0;
}

void main() {
  vec2 px = outTexCoord * uResolution;
  vec2 seed = vec2(uPhase * 17.31, uPhase * 31.77);
  // Whole device pixels only.
  vec2 off = floor(vec2(vnoise(px / 70.0 + seed), vnoise(px / 70.0 + seed + 9.1)) * uBoil + 0.5);
  if (uShimmer > 0.0) {
    float k = uShimmer * (0.35 + 0.65 * outTexCoord.y);
    off.x += sin(px.y * 0.045 - uTime * 2.6) * k + sin(px.y * 0.11 + uTime * 1.7) * k * 0.4;
    off.y += sin(px.x * 0.03 + uTime * 1.9) * k * 0.5;
  }
  vec4 c = texture2D(uMainSampler, outTexCoord + off / uResolution);
  c.rgb *= 1.0 - uDim;
  gl_FragColor = c;
}
`;

export class FrameFX extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  /** Max displacement, device px (0 = off). */
  boil = 1.4;
  shimmer = 0;
  dim = 0;
  private phase0 = Math.random() * 1000;

  constructor(game: Phaser.Game) { super({ game, name: 'FrameFX', fragShader: FRAG }); }

  onPreRender(): void {
    const reduced = settings.get('reducedMotion');
    const t = this.game.loop.time;
    const phase = reduced ? 0 : Math.floor(((t + this.phase0) / 1000) * BOIL_FPS_SCENERY) % 3;
    this.set1f('uPhase', phase);
    this.set1f('uBoil', reduced ? 0 : this.boil);
    this.set1f('uShimmer', reduced ? 0 : this.shimmer);
    this.set1f('uTime', t / 1000);
    this.set1f('uDim', this.dim);
    this.set2f('uResolution', this.renderer.width, this.renderer.height);
  }
}

/** Attach FrameFX to an image or container and return its instance (WebGL only). */
export function frameFx(img: Phaser.GameObjects.Image | Phaser.GameObjects.Container): FrameFX | null {
  const r = img.scene.game.renderer;
  if (!(r instanceof Phaser.Renderer.WebGL.WebGLRenderer)) return null;
  if (!r.pipelines.getPostPipeline('FrameFX')) r.pipelines.addPostPipeline('FrameFX', FrameFX);
  img.setPostPipeline('FrameFX');
  return img.getPostPipeline('FrameFX') as FrameFX;
}
