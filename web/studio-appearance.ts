export type StudioTheme = 'light' | 'black';
const preferenceKey = 'wanling-studio-theme';
const root = document.documentElement;
let background: HTMLDivElement | undefined;
let redraw = () => {};

export function currentStudioTheme(): StudioTheme {
  return root.dataset.studioTheme === 'light' ? 'light' : 'black';
}

export function setStudioTheme(theme: StudioTheme, persist = true) {
  root.dataset.studioTheme = theme;
  if (persist) { try { localStorage.setItem(preferenceKey, theme); } catch {} }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f6f8fc' : '#05070b';
  document.querySelectorAll<HTMLButtonElement>('[data-action="studio-theme"]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
  });
  redraw();
}

export function renderStudioThemePicker() {
  const theme = currentStudioTheme();
  return `<div class="studio-theme-picker" role="group" aria-label="界面外观"><button type="button" data-action="studio-theme" data-theme="light" aria-pressed="${theme === 'light'}"><span class="theme-swatch theme-swatch-light" aria-hidden="true"></span>浅色</button><button type="button" data-action="studio-theme" data-theme="black" aria-pressed="${theme === 'black'}"><span class="theme-swatch theme-swatch-black" aria-hidden="true"></span>黑色</button></div>`;
}

export function setStudioAppearancePage(page: string) {
  const scene = ({ home: 'home', settings: 'overview', episodes: 'overview', sourcePlan: 'source', source: 'source', script: 'source', assets: 'assets', effects: 'assets', canvas: 'canvas', tasks: 'tasks', export: 'export', review: 'export', provider: 'settings' } as Record<string, string>)[page] || 'overview';
  root.dataset.studioPage = page;
  root.dataset.studioScene = scene;
  // Changing CSS backgrounds needs no page rerender and never changes production data.
  redraw();
}

export function initializeStudioAppearance() {
  if (background?.isConnected) return;
  let saved: string | null = null;
  try { saved = localStorage.getItem(preferenceKey); } catch {}
  setStudioTheme(saved === 'light' ? 'light' : 'black', false);
  background = document.createElement('div');
  background.className = 'studio-cosmos';
  background.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  canvas.className = 'studio-star-glow';
  background.append(canvas);
  document.body.prepend(background);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, frame = 0, previousFrame = 0;
  let stars: {x: number; y: number; radius: number; phase: number}[] = [];
  const pointer = { x: -500, y: -500, targetX: -500, targetY: -500, intensity: 0, targetIntensity: 0 };

  function paint(time: number) {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const light = currentStudioTheme() === 'light';
    const reading = root.dataset.studioScene !== 'home';
    const rgb = light ? '61,122,190' : '152,218,255';
    const strength = reading ? .55 : 1;
    if (pointer.intensity > .005) {
      const glow = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 170);
      glow.addColorStop(0, `rgba(${rgb},${pointer.intensity * (light ? .08 : .11) * strength})`);
      glow.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = glow; ctx.fillRect(0, 0, width, height);
    }
    for (const star of stars) {
      const near = Math.max(0, 1 - Math.hypot(star.x - pointer.x, star.y - pointer.y) / 155) * pointer.intensity;
      const pulse = reducedMotion.matches ? 1 : .78 + .22 * Math.sin(time * .004 + star.phase);
      const alpha = ((light ? .10 : .13) + near * .72 * pulse) * strength;
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.shadowColor = `rgba(${rgb},${near * .8 * strength})`; ctx.shadowBlur = near * 12;
      ctx.beginPath(); ctx.arc(star.x, star.y, star.radius * (.65 + near * .65), 0, Math.PI * 2); ctx.fill();
      if (near > .3) {
        ctx.shadowBlur = 0; ctx.strokeStyle = `rgba(${rgb},${near * .55 * strength})`; ctx.lineWidth = .7;
        ctx.beginPath(); ctx.moveTo(star.x - 3.5 * near, star.y); ctx.lineTo(star.x + 3.5 * near, star.y);
        ctx.moveTo(star.x, star.y - 3.5 * near); ctx.lineTo(star.x, star.y + 3.5 * near); ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }
  function resize() {
    if (!ctx) return;
    width = innerWidth; height = innerHeight;
    const scale = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    let seed = 8517;
    const random = () => { seed = seed * 16807 % 2147483647; return (seed - 1) / 2147483646; };
    stars = Array.from({length: Math.min(360, Math.max(120, Math.round(width * height / 4500)))}, () => ({x: random() * width, y: random() * height, radius: .5 + random() * 1.1, phase: random() * Math.PI * 2}));
    paint(performance.now());
  }
  function animate(time: number) {
    if (document.hidden || reducedMotion.matches) { frame = 0; return; }
    // Limit decorative work to 30 fps, independently of canvas editing and playback.
    if (time - previousFrame >= 30) {
      previousFrame = time;
      pointer.x += (pointer.targetX - pointer.x) * .25;
      pointer.y += (pointer.targetY - pointer.y) * .25;
      pointer.intensity += (pointer.targetIntensity - pointer.intensity) * .20;
      paint(time);
    }
    if (pointer.targetIntensity || Math.abs(pointer.intensity - pointer.targetIntensity) > .004) frame = requestAnimationFrame(animate);
    else frame = 0;
  }
  function resetPointer() {
    pointer.targetIntensity = 0;
    if (reducedMotion.matches || document.hidden) { pointer.intensity = 0; cancelAnimationFrame(frame); frame = 0; paint(0); }
    else if (!frame) frame = requestAnimationFrame(animate);
  }
  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || document.hidden) return;
    pointer.targetX = event.clientX; pointer.targetY = event.clientY;
    if (!pointer.targetIntensity) { pointer.x = pointer.targetX; pointer.y = pointer.targetY; }
    pointer.targetIntensity = 1;
    if (reducedMotion.matches) { pointer.x = pointer.targetX; pointer.y = pointer.targetY; pointer.intensity = 1; paint(0); }
    else if (!frame) frame = requestAnimationFrame(animate);
  }, {passive: true});
  document.documentElement.addEventListener('pointerleave', resetPointer);
  window.addEventListener('blur', resetPointer);
  document.addEventListener('visibilitychange', resetPointer);
  reducedMotion.addEventListener('change', resetPointer);
  window.addEventListener('resize', resize, {passive: true});
  window.addEventListener('storage', event => { if (event.key === preferenceKey) setStudioTheme(event.newValue === 'light' ? 'light' : 'black', false); });
  redraw = () => paint(performance.now());
  resize();
}
