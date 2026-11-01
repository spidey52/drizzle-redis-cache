function formatHourLabel(stat) {
  if (!stat) return '';
  if (stat.hourStart) {
    try {
      const d = new Date(stat.hourStart);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
    } catch {
      /* ignore */
    }
  }
  const h = String(stat.hour || '');
  if (h.length >= 10) return `${h.slice(0, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)} ${h.slice(8, 10)}:00`;
  return h;
}

function pct(rate) {
  return ((rate || 0) * 100).toFixed(1) + '%';
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Hit-rate line over stacked hit/miss volume bars, with crosshair and tooltip.
 * Colours come from CSS variables so it follows the theme.
 */
export function createChart({ wrap, canvas, tooltip }) {
  const ctx = canvas.getContext('2d');
  let statsData = [];
  let hoverIndex = -1;
  let onHover = null;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function layout() {
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    const pad = { top: 18, right: 14, bottom: 30, left: 44 };
    return { cssW, cssH, pad, plotW: cssW - pad.left - pad.right, plotH: cssH - pad.top - pad.bottom };
  }

  function pointAt(i, L) {
    const n = Math.max(statsData.length - 1, 1);
    const x = L.pad.left + (i * L.plotW) / n;
    const rate = statsData[i]?.hitRate || 0;
    return { x, y: L.pad.top + (1 - rate) * L.plotH, rate };
  }

  function nearestIndex(clientX) {
    if (!statsData.length) return -1;
    const rect = wrap.getBoundingClientRect();
    const L = layout();
    const x = clientX - rect.left;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < statsData.length; i++) {
      const d = Math.abs(pointAt(i, L).x - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function draw() {
    resizeCanvas();
    const L = layout();
    const { cssW, cssH, pad, plotW, plotH } = L;
    const bg = cssVar('--chart-bg', '#0d1520');
    const grid = cssVar('--chart-grid', 'rgba(42,53,72,0.9)');
    const text = cssVar('--muted', '#8b9bb4');
    const accent = cssVar('--accent', '#4d9fff');
    const ok = cssVar('--ok-soft', 'rgba(62,207,142,0.45)');
    const bad = cssVar('--bad-soft', 'rgba(240,113,120,0.35)');

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g++) {
      const y = pad.top + (g / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(String(100 - g * 25) + '%', pad.left - 8, y);
    }

    if (!statsData.length || !statsData.some((s) => (s.hits || 0) + (s.misses || 0) > 0)) {
      ctx.textAlign = 'center';
      ctx.fillText('No traffic in this window', cssW / 2, cssH / 2);
      tooltip.classList.remove('show');
      return;
    }

    const maxVol = Math.max(1, ...statsData.map((s) => (s.hits || 0) + (s.misses || 0)));
    const barW = Math.max(2, (plotW / statsData.length) * 0.6);
    for (let i = 0; i < statsData.length; i++) {
      const s = statsData[i];
      const total = (s.hits || 0) + (s.misses || 0);
      const h = (total / maxVol) * (plotH * 0.4);
      const x = pointAt(i, L).x - barW / 2;
      const yBase = pad.top + plotH;
      const hitH = total ? ((s.hits || 0) / total) * h : 0;
      ctx.fillStyle = bad;
      ctx.fillRect(x, yBase - (h - hitH), barW, h - hitH);
      ctx.fillStyle = ok;
      ctx.fillRect(x, yBase - h, barW, hitH);
    }

    ctx.beginPath();
    for (let i = 0; i < statsData.length; i++) {
      const p = pointAt(i, L);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    }
    const last = pointAt(statsData.length - 1, L);
    const first = pointAt(0, L);
    ctx.lineTo(last.x, pad.top + plotH);
    ctx.lineTo(first.x, pad.top + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, cssVar('--accent-fill-top', 'rgba(77,159,255,0.28)'));
    grad.addColorStop(1, cssVar('--accent-fill-bottom', 'rgba(77,159,255,0.02)'));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < statsData.length; i++) {
      const p = pointAt(i, L);
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    if (statsData.length <= 60) {
      for (let i = 0; i < statsData.length; i++) {
        const p = pointAt(i, L);
        const active = i === hoverIndex;
        ctx.beginPath();
        ctx.arc(p.x, p.y, active ? 5 : 2.5, 0, Math.PI * 2);
        ctx.fillStyle = active ? '#fff' : accent;
        ctx.fill();
      }
    }

    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.ceil(statsData.length / Math.max(3, Math.floor(plotW / 110))));
    for (let i = 0; i < statsData.length; i += labelEvery) {
      const p = pointAt(i, L);
      ctx.fillText(formatHourLabel(statsData[i]).replace(/,?\s*\d{4}/, ''), p.x, pad.top + plotH + 8);
    }

    if (hoverIndex >= 0 && hoverIndex < statsData.length) {
      const p = pointAt(hoverIndex, L);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = cssVar('--chart-cross', 'rgba(232,238,247,0.35)');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, pad.top);
      ctx.lineTo(p.x, pad.top + plotH);
      ctx.stroke();
      ctx.restore();

      const s = statsData[hoverIndex];
      const hits = s.hits || 0;
      const misses = s.misses || 0;
      const rows = [
        ['Hit rate', pct(s.hitRate)],
        ['Hits', hits.toLocaleString()],
        ['Misses', misses.toLocaleString()],
      ];
      if (s.skipped != null) rows.push(['Stepped aside', Number(s.skipped).toLocaleString()]);
      if (s.bypassed) rows.push(['Redis failures', Number(s.bypassed).toLocaleString()]);
      tooltip.innerHTML =
        `<div class="t">${formatHourLabel(s)}</div>` +
        rows.map(([k, v]) => `<div class="r"><span>${k}</span><b>${v}</b></div>`).join('');
      tooltip.classList.add('show');
      const tipW = tooltip.offsetWidth || 180;
      const tipH = tooltip.offsetHeight || 110;
      let left = p.x + 14;
      let top = p.y - tipH - 10;
      if (left + tipW > cssW - 8) left = p.x - tipW - 14;
      if (top < 8) top = p.y + 14;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
      onHover?.(hoverIndex);
    } else {
      tooltip.classList.remove('show');
    }
  }

  wrap.addEventListener('mousemove', (e) => {
    hoverIndex = nearestIndex(e.clientX);
    draw();
  });
  wrap.addEventListener('mouseleave', () => {
    hoverIndex = -1;
    draw();
  });

  return {
    setStats(stats) {
      statsData = stats || [];
      draw();
    },
    redraw: draw,
    onHover(fn) {
      onHover = fn;
    },
    formatHourLabel,
    pct,
  };
}
