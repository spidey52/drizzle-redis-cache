function formatHourLabel(stat) {
  if (!stat) return '';
  if (stat.hourStart) {
    try {
      const d = new Date(stat.hourStart);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    } catch {
      /* ignore */
    }
  }
  const h = String(stat.hour || '');
  if (h.length >= 10) {
    return `${h.slice(0, 4)}-${h.slice(4, 6)}-${h.slice(6, 8)} ${h.slice(8, 10)}:00`;
  }
  return h;
}

function pct(rate) {
  return ((rate || 0) * 100).toFixed(1) + '%';
}

/**
 * Interactive hit-rate chart with volume bars, crosshair, and tooltip.
 */
export function createChart({ wrap, canvas, tooltip }) {
  const ctx = canvas.getContext('2d');
  let statsData = [];
  let hoverIndex = -1;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function chartLayout() {
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    const pad = { top: 24, right: 18, bottom: 36, left: 48 };
    return {
      cssW,
      cssH,
      pad,
      plotW: cssW - pad.left - pad.right,
      plotH: cssH - pad.top - pad.bottom,
    };
  }

  function pointAt(i, layout) {
    const n = Math.max(statsData.length - 1, 1);
    const x = layout.pad.left + (i * layout.plotW) / n;
    const rate = statsData[i]?.hitRate || 0;
    const y = layout.pad.top + (1 - rate) * layout.plotH;
    return { x, y, rate };
  }

  function nearestIndex(clientX) {
    if (!statsData.length) return -1;
    const rect = wrap.getBoundingClientRect();
    const layout = chartLayout();
    const x = clientX - rect.left;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < statsData.length; i++) {
      const d = Math.abs(pointAt(i, layout).x - x);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function draw() {
    resizeCanvas();
    const layout = chartLayout();
    const { cssW, cssH, pad, plotW, plotH } = layout;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#0d1520';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.strokeStyle = 'rgba(42,53,72,0.9)';
    ctx.lineWidth = 1;
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillStyle = '#8b9bb4';
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

    if (!statsData.length) {
      ctx.textAlign = 'center';
      ctx.fillText('No stats yet', cssW / 2, cssH / 2);
      tooltip.classList.remove('show');
      return;
    }

    const maxVol = Math.max(
      1,
      ...statsData.map((s) => (s.hits || 0) + (s.misses || 0)),
    );
    const barW = Math.max(2, (plotW / statsData.length) * 0.55);

    for (let i = 0; i < statsData.length; i++) {
      const s = statsData[i];
      const total = (s.hits || 0) + (s.misses || 0);
      const h = (total / maxVol) * (plotH * 0.35);
      const x = pointAt(i, layout).x - barW / 2;
      const yBase = pad.top + plotH;
      const hitH = total ? ((s.hits || 0) / total) * h : 0;
      const missH = h - hitH;
      ctx.fillStyle = 'rgba(240,113,120,0.35)';
      ctx.fillRect(x, yBase - missH, barW, missH);
      ctx.fillStyle = 'rgba(62,207,142,0.45)';
      ctx.fillRect(x, yBase - h, barW, hitH);
    }

    ctx.beginPath();
    for (let i = 0; i < statsData.length; i++) {
      const p = pointAt(i, layout);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    const last = pointAt(statsData.length - 1, layout);
    const first = pointAt(0, layout);
    ctx.lineTo(last.x, pad.top + plotH);
    ctx.lineTo(first.x, pad.top + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
    grad.addColorStop(0, 'rgba(77,159,255,0.28)');
    grad.addColorStop(1, 'rgba(77,159,255,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < statsData.length; i++) {
      const p = pointAt(i, layout);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = '#4d9fff';
    ctx.lineWidth = 2.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    for (let i = 0; i < statsData.length; i++) {
      const p = pointAt(i, layout);
      const active = i === hoverIndex;
      ctx.beginPath();
      ctx.arc(p.x, p.y, active ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#fff' : '#4d9fff';
      ctx.fill();
      if (active) {
        ctx.strokeStyle = '#4d9fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#8b9bb4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const labelEvery = Math.max(1, Math.ceil(statsData.length / 6));
    for (let i = 0; i < statsData.length; i += labelEvery) {
      const p = pointAt(i, layout);
      const label = formatHourLabel(statsData[i]).replace(/,?\s*\d{4}/, '');
      ctx.fillText(label, p.x, pad.top + plotH + 10);
    }

    if (hoverIndex >= 0 && hoverIndex < statsData.length) {
      const p = pointAt(hoverIndex, layout);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(232,238,247,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, pad.top);
      ctx.lineTo(p.x, pad.top + plotH);
      ctx.moveTo(pad.left, p.y);
      ctx.lineTo(pad.left + plotW, p.y);
      ctx.stroke();
      ctx.restore();

      const s = statsData[hoverIndex];
      const hits = s.hits || 0;
      const misses = s.misses || 0;
      const total = hits + misses;
      tooltip.innerHTML = `
        <div class="t">${formatHourLabel(s)}</div>
        <div class="r"><span>Hit rate</span><b>${pct(s.hitRate)}</b></div>
        <div class="r"><span>Hits</span><b>${hits.toLocaleString()}</b></div>
        <div class="r"><span>Misses</span><b>${misses.toLocaleString()}</b></div>
        <div class="r"><span>Total</span><b>${total.toLocaleString()}</b></div>
      `;
      tooltip.classList.add('show');
      const tipW = tooltip.offsetWidth || 180;
      const tipH = tooltip.offsetHeight || 110;
      let left = p.x + 14;
      let top = p.y - tipH - 10;
      if (left + tipW > cssW - 8) left = p.x - tipW - 14;
      if (top < 8) top = p.y + 14;
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
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
    formatHourLabel,
    pct,
  };
}
