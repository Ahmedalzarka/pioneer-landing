// Liquid lens: a soft, fluid distortion that follows the cursor over the whole page,
// on top of everything (text, buttons, photos). A chain of round "droplets" trails
// the cursor; each one warps whatever is behind it through an SVG turbulence filter,
// so the page looks like it is seen through moving water. It fades out when the
// mouse stops.
//
// Desktop (mouse) only. Browsers that cannot distort a backdrop through an SVG filter
// (Safari, Firefox) get a gentle blur instead. Off for reduced-motion users.
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  var DROPS = 7;          // droplets in the trail
  var SIZE = 170;         // diameter of the lead droplet, px
  var SCALE = 26;         // distortion strength
  var FILTER = 'url(#pp-liquid)';
  var canWarp = CSS.supports('backdrop-filter', FILTER) || CSS.supports('-webkit-backdrop-filter', FILTER);

  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  svg.innerHTML =
    '<filter id="pp-liquid" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">' +
    '<feTurbulence id="pp-liquid-noise" type="fractalNoise" baseFrequency="0.011 0.016" numOctaves="2" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + SCALE + '" xChannelSelector="R" yChannelSelector="G"/>' +
    '</filter>';
  document.body.appendChild(svg);
  var noise = svg.querySelector('#pp-liquid-noise');

  var style = document.createElement('style');
  style.textContent =
    '.pp-drop{position:fixed;left:0;top:0;border-radius:50%;pointer-events:none;z-index:90;opacity:0;will-change:transform,opacity;' +
    (canWarp ? '-webkit-backdrop-filter:' + FILTER + ';backdrop-filter:' + FILTER + ';'
             : '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);') +
    '-webkit-mask-image:radial-gradient(circle closest-side,#000 45%,transparent 100%);mask-image:radial-gradient(circle closest-side,#000 45%,transparent 100%)}';
  document.head.appendChild(style);

  var drops = [];
  for (var i = 0; i < DROPS; i++) {
    var el = document.createElement('div');
    el.className = 'pp-drop';
    el.setAttribute('aria-hidden', 'true');
    var size = Math.round(SIZE * (1 - i * 0.09));
    el.style.width = el.style.height = size + 'px';
    document.body.appendChild(el);
    drops.push({ el: el, x: -999, y: -999, size: size });
  }

  var mx = -999, my = -999, energy = 0, running = false, t = 0;

  window.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    var dx = e.clientX - mx, dy = e.clientY - my;
    if (mx < -900) drops.forEach(function (d) { d.x = e.clientX; d.y = e.clientY; });
    else energy = Math.min(1, energy + Math.hypot(dx, dy) / 140);
    mx = e.clientX; my = e.clientY;
    if (!running) { running = true; requestAnimationFrame(tick); }
  }, { passive: true });
  document.addEventListener('pointerleave', function () { energy = 0; });

  function tick() {
    t += 1 / 60;
    // Each droplet chases the one ahead of it, the lead chases the cursor: a fluid trail.
    var tx = mx, ty = my;
    for (var i = 0; i < drops.length; i++) {
      var d = drops[i], k = i === 0 ? 0.3 : 0.38;
      d.x += (tx - d.x) * k;
      d.y += (ty - d.y) * k;
      var a = energy * (1 - i / (drops.length + 1));
      d.el.style.opacity = a.toFixed(3);
      d.el.style.transform = 'translate3d(' + (d.x - d.size / 2) + 'px,' + (d.y - d.size / 2) + 'px,0)';
      tx = d.x; ty = d.y;
    }
    // Let the "water" keep moving a little.
    if (canWarp) noise.setAttribute('baseFrequency', (0.011 + Math.sin(t * 1.3) * 0.0015).toFixed(4) + ' ' + (0.016 + Math.cos(t) * 0.0015).toFixed(4));
    energy *= 0.95;
    if (energy > 0.01) requestAnimationFrame(tick);
    else { running = false; drops.forEach(function (d) { d.el.style.opacity = '0'; }); }
  }
})();
