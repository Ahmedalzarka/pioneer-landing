// Liquid grid: the page's background grid behaves like the surface of a liquid.
// Moving the cursor pushes the lines along with it, the disturbance ripples outward,
// and lines soften and blur where they move fastest before settling back.
// On touch screens a tap sends a ripple out from the touch point instead.
//
// One fixed, viewport-sized canvas sits behind all page content and redraws the
// page grid (which it hides from CSS), lined up with the page as it scrolls.
// Sections with a tinted background are translucent, so their tint sits on top.
(function () {
  var CELL = 48;          // page grid spacing, must match .pp background-size
  var NODE = 16;          // spacing of the simulation mesh
  var STEP = 6;           // sample spacing along each drawn line
  var STIFF = 0.05, NEIGH = 0.16, DAMP = 0.86, PUSH = 0.22, RADIUS = 55;
  var TAP_RADIUS = 110, TAP_FORCE = 3.2;

  var page = document.getElementById('pp');
  if (!page) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var style = document.createElement('style');
  style.textContent =
    // 100lvh = the tallest viewport, so a phone's address bar showing or hiding never resizes it.
    '.fx-canvas{position:fixed;left:0;top:0;width:100vw;height:100vh;height:100lvh;pointer-events:none;z-index:0}' +
    '.pp.fx-on{background-image:none}' +
    // Lift page content above the canvas (the sticky header and fixed bar already stack above it).
    '.pp.fx-on>:not(.fx-canvas):not(.hdr):not(.mbar):not(script):not(svg){position:relative;z-index:1}';
  document.head.appendChild(style);

  var canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  page.prepend(canvas);
  page.classList.add('fx-on');
  var ctx = canvas.getContext('2d');

  var w = 0, h = 0, cols, rows, dx, dy, vx, vy, bg, line;
  var mx = -9999, my = -9999, pmx = -9999, pmy = -9999, inside = false;
  var calm = 0, taps = [], lastTop = null, shiftAcc = 0;

  // ---- input -------------------------------------------------------------
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;      // a dragging finger is a scroll
    mx = e.clientX; my = e.clientY;
    if (!inside) { pmx = mx; pmy = my; }
    inside = true;
  }, { passive: true });
  document.addEventListener('pointerleave', function () { inside = false; mx = my = -9999; });
  window.addEventListener('blur', function () { inside = false; mx = my = -9999; });
  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') taps.push({ x: e.clientX, y: e.clientY });
  }, { passive: true });

  // ---- colours -----------------------------------------------------------
  function readColors() {
    var cs = getComputedStyle(page);
    bg = cs.getPropertyValue('--bg').trim() || '#0A1326';
    var g = cs.getPropertyValue('--grid').trim() || 'rgba(167,173,181,.06)';
    var m = g.match(/rgba?\(([^)]+)\)/);
    var parts = m ? m[1].split(',') : ['167', '173', '181', '.06'];
    line = { rgb: parts.slice(0, 3).join(','), a: parseFloat(parts[3] || '1') };
    calm = 0;
  }
  // Repaint in the new colours the moment the theme changes.
  if ('MutationObserver' in window) {
    new MutationObserver(readColors).observe(page, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---- sizing ------------------------------------------------------------
  function resize() {
    var r = canvas.getBoundingClientRect();
    if (Math.abs(r.width - w) < 1 && Math.abs(r.height - h) < 1) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / NODE) + 3;
    rows = Math.ceil(h / NODE) + 3;
    var n = cols * rows;
    dx = new Float32Array(n); dy = new Float32Array(n);
    vx = new Float32Array(n); vy = new Float32Array(n);
    calm = 0;
  }
  window.addEventListener('resize', resize);

  // Move the disturbance with the page while scrolling, a whole mesh row at a time.
  function shiftRows(k) {
    var off = k * cols;
    [dx, dy, vx, vy].forEach(function (arr) {
      if (k > 0) { arr.copyWithin(0, off); arr.fill(0, arr.length - off); }
      else { arr.copyWithin(-off, 0, arr.length + off); arr.fill(0, 0, -off); }
    });
  }

  function sample(arr, x, y) {
    var gx = x / NODE, gy = y / NODE;
    var x0 = Math.max(0, Math.min(cols - 2, Math.floor(gx))), y0 = Math.max(0, Math.min(rows - 2, Math.floor(gy)));
    var fx = Math.min(1, Math.max(0, gx - x0)), fy = Math.min(1, Math.max(0, gy - y0));
    var i = y0 * cols + x0;
    return (arr[i] * (1 - fx) + arr[i + 1] * fx) * (1 - fy) + (arr[i + cols] * (1 - fx) + arr[i + cols + 1] * fx) * fy;
  }

  function push(cx, cy, r, fn) {
    var c0 = Math.max(1, Math.floor((cx - r) / NODE)), c1 = Math.min(cols - 2, Math.ceil((cx + r) / NODE));
    var r0 = Math.max(1, Math.floor((cy - r) / NODE)), r1 = Math.min(rows - 2, Math.ceil((cy + r) / NODE));
    for (var y = r0; y <= r1; y++) for (var x = c0; x <= c1; x++) fn(y * cols + x, x * NODE - cx, y * NODE - cy);
  }

  // ---- frame -------------------------------------------------------------
  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;

    // Where the page (and so its grid) sits right now.
    var pr = page.getBoundingClientRect();
    var offX = ((pr.left % CELL) + CELL) % CELL, offY = ((pr.top % CELL) + CELL) % CELL;
    var scrolled = lastTop !== null && pr.top !== lastTop;
    if (scrolled) {
      calm = 0;
      shiftAcc += lastTop - pr.top;
      var k = (shiftAcc / NODE) | 0;
      if (k) { shiftRows(Math.max(-rows, Math.min(rows, k))); shiftAcc -= k * NODE; }
    }
    lastTop = pr.top;

    var mvx = mx - pmx, mvy = my - pmy;
    var moving = inside && pmx > -9000 && (mvx * mvx + mvy * mvy) > 0.25;
    pmx = mx; pmy = my;
    if (moving) {
      calm = 0;
      var r2 = RADIUS * RADIUS;
      push(mx, my, RADIUS, function (i, ex, ey) {
        var e2 = ex * ex + ey * ey;
        if (e2 < r2) { var f = Math.exp(-e2 / (r2 * 0.25)) * PUSH; vx[i] += mvx * f; vy[i] += mvy * f; }
      });
    }
    while (taps.length) {
      var tp = taps.shift(), tr2 = TAP_RADIUS * TAP_RADIUS;
      calm = 0;
      push(tp.x, tp.y, TAP_RADIUS, function (i, qx, qy) {
        var q2 = qx * qx + qy * qy;
        if (q2 < tr2 && q2 > 1) {
          var q = Math.sqrt(q2), ring = (q / TAP_RADIUS) * Math.exp(-q2 / (tr2 * 0.2)) * TAP_FORCE;
          vx[i] += (qx / q) * ring; vy[i] += (qy / q) * ring;
        }
      });
    }

    // Nothing moving, nothing scrolled, nothing new: do no work at all.
    if (!moving && !scrolled && calm > 2) return;

    // Spring each node home and couple it to its neighbours so motion ripples outward.
    var energy = 0;
    for (var y = 1; y < rows - 1; y++) for (var x = 1; x < cols - 1; x++) {
      var i = y * cols + x;
      var lx = dx[i - 1] + dx[i + 1] + dx[i - cols] + dx[i + cols] - 4 * dx[i];
      var ly = dy[i - 1] + dy[i + 1] + dy[i - cols] + dy[i + cols] - 4 * dy[i];
      vx[i] = (vx[i] + lx * NEIGH - dx[i] * STIFF) * DAMP;
      vy[i] = (vy[i] + ly * NEIGH - dy[i] * STIFF) * DAMP;
      energy += Math.abs(vx[i]) + Math.abs(vy[i]) + Math.abs(dx[i]) + Math.abs(dy[i]);
    }
    for (var j = 0; j < dx.length; j++) { dx[j] += vx[j]; dy[j] += vy[j]; }

    if (energy < 0.5 && !moving) {
      // Snap the last tiny offsets home so the grid ends perfectly straight,
      // then draw one final frame (or one per scroll step) and go idle.
      dx.fill(0); dy.fill(0); vx.fill(0); vy.fill(0);
      if (!scrolled) calm++;
    }
    draw(offX, offY, energy < 0.5);
  }

  function draw(offX, offY, still) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.lineCap = 'round';

    // At rest: plain straight lines, one stroke.
    if (still) {
      ctx.strokeStyle = 'rgba(' + line.rgb + ',' + line.a + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = offX; x <= w; x += CELL) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
      for (var y = offY; y <= h; y += CELL) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
      ctx.stroke();
      return;
    }

    // Moving: each line is a chain of short segments, sorted into a few intensity
    // levels so each level is one stroke call. Faster-moving parts get wider and
    // fainter, which reads as a liquid blur.
    var LEVELS = 6, paths = [], lv;
    for (lv = 0; lv < LEVELS; lv++) paths.push(new Path2D());
    function strokeLine(pts) {
      for (var p = 1; p < pts.length; p++) {
        var a = pts[p - 1], b = pts[p];
        var level = Math.min(LEVELS - 1, Math.floor((a[2] + b[2]) * 0.09 * LEVELS));
        paths[level].moveTo(a[0], a[1]);
        paths[level].lineTo(b[0], b[1]);
      }
    }
    function point(px, py) {
      var ux = sample(dx, px, py), uy = sample(dy, px, py);
      return [px + ux + 0.5, py + uy + 0.5, Math.abs(sample(vx, px, py)) + Math.abs(sample(vy, px, py)) + Math.hypot(ux, uy) * 0.15];
    }
    var px, py, pts;
    for (px = offX; px <= w; px += CELL) {
      pts = [];
      for (py = -STEP; py <= h + STEP; py += STEP) pts.push(point(px, py));
      strokeLine(pts);
    }
    for (py = offY; py <= h; py += CELL) {
      pts = [];
      for (px = -STEP; px <= w + STEP; px += STEP) pts.push(point(px, py));
      strokeLine(pts);
    }
    for (lv = 0; lv < LEVELS; lv++) {
      var sp = lv / (LEVELS - 1);
      ctx.strokeStyle = 'rgba(' + line.rgb + ',' + (line.a * (1 + sp * 1.5) / (1 + sp * 4)).toFixed(4) + ')';
      ctx.lineWidth = 1 + sp * 2.5;
      ctx.stroke(paths[lv]);
    }
  }

  readColors();
  resize();
  requestAnimationFrame(frame);
})();
