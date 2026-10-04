/**
 * Where brush strokes are rendered to, and when they are rendered.
 *
 * ATLAS. Each scene packs its brush strokes into a few shared 2048x2048 CPU
 * canvas pages (simple shelf packing). The GPU copy of a page is allocated
 * empty and only the small rectangle each new shape occupies is uploaded
 * (texSubImage2D). Measured on the title screen: one texture per shape cost
 * ~2–3 s of upload overhead; re-uploading whole pages cost 175 uploads / 3.6 s
 * with single frames up to ~1 s. Sub-rect uploads are a few ms in total.
 *
 * QUEUE. Shapes can be rendered later rather than at construction: the queue
 * drains a time budget's worth per frame, so building a scene never freezes
 * the game. UI renders immediately; scenery is queued.
 */

import Phaser from 'phaser';

/** Dev counters for the atlas (surfaced via window.__atlasStats in dev). */
export const atlasStats = {
  flushes: 0, flushMs: 0, maxFlushMs: 0, pages: 0, drainMs: 0, maxJobMs: 0,
};

export const ATLAS_PAGE = 2048;
/** Gap between packed rects so linear filtering never bleeds a neighbour in. */
const GUTTER = 2;
/** Per-frame budget for queued brush rendering. */
const BUDGET_MS = 9;

interface Page {
  key: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: Phaser.Textures.Texture;
  /** WebGL texture for sub-rect uploads; absent on the Canvas renderer. */
  gl?: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper;
  shelfY: number;
  shelfH: number;
  cursorX: number;
}


export interface AtlasRect {
  key: string;
  ctx: CanvasRenderingContext2D;
  tex: Phaser.Textures.Texture;
  x: number;
  y: number;
  /** Queue an upload of the given sub-rectangle (page px) for this frame. */
  markDirty: (x: number, y: number, w: number, h: number) => void;
  /** True for a dedicated page (allocOwn); free it with releaseOwn(key). */
  own: boolean;
}

interface PendingUpload { page: Page; x: number; y: number; w: number; h: number }

let pageUid = 0;
/**
 * Pools keep strokes that are on screen every frame (UI) on different pages
 * from strokes still being filled in (deferred scenery, hidden until revealed).
 * Writing into a page the GPU is drawing from forces a sync stall — measured at
 * up to ~0.7 s for one small upload.
 */
export type AtlasPool = 'ui' | 'scenery';
const atlases = new WeakMap<Phaser.Scene, Map<AtlasPool, BrushAtlas>>();

export class BrushAtlas {
  private pages: Page[] = [];
  private ownPages: Page[] = [];
  private uploads: PendingUpload[] = [];
  private queue: Array<() => void> = [];
  private idleWaiters: Array<() => void> = [];
  private destroyed = false;

  static for(scene: Phaser.Scene, pool: AtlasPool = 'ui'): BrushAtlas {
    let m = atlases.get(scene);
    if (!m) { m = new Map(); atlases.set(scene, m); }
    let a = m.get(pool);
    if (!a) { a = new BrushAtlas(scene, pool); m.set(pool, a); }
    return a;
  }

  private constructor(private scene: Phaser.Scene, private pool: AtlasPool) {
    scene.events.on(Phaser.Scenes.Events.PRE_UPDATE, this.drain, this);
    scene.events.on(Phaser.Scenes.Events.PRE_RENDER, this.flush, this);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.destroy());
  }

  /** Reserve w x h px; null if it can never fit on a page. */
  alloc(w: number, h: number): AtlasRect | null {
    if (w > ATLAS_PAGE || h > ATLAS_PAGE) return null;
    let page = this.pages[this.pages.length - 1];
    const fits = (p: Page) => {
      if (p.cursorX + w <= ATLAS_PAGE && p.shelfY + Math.max(p.shelfH, h) <= ATLAS_PAGE) return true;
      return p.shelfY + p.shelfH + GUTTER + h <= ATLAS_PAGE; // next shelf
    };
    if (!page || !fits(page)) page = this.newPage();
    if (page.cursorX + w > ATLAS_PAGE) {
      page.shelfY += page.shelfH + GUTTER;
      page.shelfH = 0;
      page.cursorX = 0;
    }
    const x = page.cursorX, y = page.shelfY;
    page.cursorX += w + GUTTER;
    page.shelfH = Math.max(page.shelfH, h);
    const p = page;
    return {
      key: p.key, ctx: p.ctx, tex: p.tex, x, y, own: false,
      markDirty: (ux, uy, uw, uh) => { this.uploads.push({ page: p, x: ux, y: uy, w: uw, h: uh }); },
    };
  }

  /**
   * A dedicated page of exactly w x h for a stroke too big to share a page
   * (e.g. a ground line spanning the screen). Same empty-allocate + sub-rect
   * upload path as shared pages — the canvas-upload path cost ~2 s for one.
   */
  allocOwn(w: number, h: number): AtlasRect {
    const page = this.newPage(w, h, false);
    return {
      key: page.key, ctx: page.ctx, tex: page.tex, x: 0, y: 0, own: true,
      markDirty: (ux, uy, uw, uh) => { this.uploads.push({ page, x: ux, y: uy, w: uw, h: uh }); },
    };
  }

  /** Free a dedicated page early (shared pages live until the scene ends). */
  releaseOwn(key: string): void {
    if (this.destroyed) return; // already freed with the scene
    const i = this.ownPages.findIndex((p) => p.key === key);
    if (i < 0) return;
    this.ownPages.splice(i, 1);
    this.uploads = this.uploads.filter((u) => u.page.key !== key);
    this.scene.textures.remove(key);
  }

  private newPage(w = ATLAS_PAGE, h = ATLAS_PAGE, shared = true): Page {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const key = `brush-atlas-${++pageUid}`;
    const renderer = this.scene.game.renderer;

    let tex: Phaser.Textures.Texture;
    let glTex: Phaser.Renderer.WebGL.Wrappers.WebGLTextureWrapper | undefined;
    if (renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
      const gl = renderer.gl;
      // Allocate empty GPU storage — uploading a blank 16 MB canvas is itself
      // a several-hundred-ms stall. Linear, no mipmaps: they would go stale as
      // sub-rects are filled in, and strokes are drawn at 1:1 anyway.
      glTex = renderer.createTexture2D(
        0, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.RGBA,
        null as unknown as HTMLCanvasElement, w, h, true, false, false,
      );
      tex = this.scene.textures.addGLTexture(key, glTex)!;
    } else {
      tex = this.scene.textures.create(key, canvas, w, h)!;
    }
    const page: Page = { key, canvas, ctx, tex, gl: glTex, shelfY: 0, shelfH: 0, cursorX: 0 };
    // Dedicated pages are tracked for cleanup but never packed into.
    if (shared) this.pages.push(page); else this.ownPages.push(page);
    atlasStats.pages++;
    return page;
  }

  /** Run `job` later, within the per-frame budget. */
  enqueue(job: () => void): void { this.queue.push(job); }

  /** Resolves once every queued render so far has run. */
  whenIdle(): Promise<void> {
    if (!this.queue.length) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  get pending(): number { return this.queue.length; }

  /** Render queued shapes until this frame's budget is spent. */
  private drain(): void {
    if (!this.queue.length) return;
    const start = performance.now();
    while (this.queue.length && performance.now() - start < BUDGET_MS) {
      const j0 = performance.now();
      this.queue.shift()!();
      atlasStats.maxJobMs = Math.max(atlasStats.maxJobMs, performance.now() - j0);
    }
    atlasStats.drainMs += performance.now() - start;
    if (!this.queue.length) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((fn) => fn());
    }
  }

  /**
   * Upload this frame's new sub-rectangles. Mirrors Phaser's own upload: save
   * the texture-unit-0 binding, upload with premultiplied alpha, restore.
   */
  private flush(): void {
    if (!this.uploads.length) return;
    const t0 = performance.now();
    const renderer = this.scene.game.renderer;
    if (renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer) {
      const gl = renderer.gl;
      gl.activeTexture(gl.TEXTURE0);
      const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      for (const u of this.uploads) {
        if (!u.page.gl?.webGLTexture) continue;
        gl.bindTexture(gl.TEXTURE_2D, u.page.gl.webGLTexture);
        const data = u.page.ctx.getImageData(u.x, u.y, u.w, u.h);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, u.x, u.y, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
      gl.bindTexture(gl.TEXTURE_2D, prev);
    } else {
      // Canvas renderer draws straight from the canvas; nothing to upload.
    }
    atlasStats.flushes += this.uploads.length;
    const dt = performance.now() - t0;
    atlasStats.flushMs += dt;
    atlasStats.maxFlushMs = Math.max(atlasStats.maxFlushMs, dt);
    this.uploads = [];
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.events.off(Phaser.Scenes.Events.PRE_UPDATE, this.drain, this);
    this.scene.events.off(Phaser.Scenes.Events.PRE_RENDER, this.flush, this);
    for (const p of [...this.pages, ...this.ownPages]) this.scene.textures.remove(p.key);
    this.pages = [];
    this.ownPages = [];
    this.queue = [];
    this.uploads = [];
    atlases.get(this.scene)?.delete(this.pool);
  }
}
