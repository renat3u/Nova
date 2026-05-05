/**
 * PressurePanel — 压力参数卡片 + 时序折线图。
 */
class PressurePanel {
  constructor(paramsContainer, timelineContainer, rangeSelector) {
    this.paramsContainer = paramsContainer;
    this.timelineContainer = timelineContainer;
    this.rangeSelector = rangeSelector;
    this.timelineChart = null;
    this.snapshots = [];
    this.timeRange = 5 * 60 * 1000;

    this.initCharts();
    this.initRangeSelector();
  }

  initCharts() {
    if (this.timelineContainer) {
      this.timelineChart = echarts.init(this.timelineContainer);
    }
  }

  initRangeSelector() {
    if (!this.rangeSelector) return;
    this.rangeSelector.querySelectorAll('.range-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.rangeSelector.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const range = btn.dataset.range;
        if (range === '5m') this.timeRange = 5 * 60 * 1000;
        else if (range === '15m') this.timeRange = 15 * 60 * 1000;
        else if (range === '1h') this.timeRange = 60 * 60 * 1000;
        this.renderTimeline();
      });
    });
  }

  updateRealtime(snapshot) {
    if (!snapshot) return;
    this.renderParams(snapshot);
  }

  updateHistory(snapshots) {
    if (!snapshots || snapshots.length === 0) return;
    this.snapshots = snapshots;
    this.renderParams(snapshots[0]);
    this.renderTimeline();
  }

  renderParams(latest) {
    if (!latest || !this.paramsContainer) return;

    const params = [
      { key: 'p1', name: 'P1', desc: '实在压力', value: latest.p1 ?? 0 },
      { key: 'p2', name: 'P2', desc: '社交压力', value: latest.p2 ?? 0 },
      { key: 'p3', name: 'P3', desc: '存在缺失', value: latest.p3 ?? 0 },
      { key: 'p4', name: 'P4', desc: '排斥压力', value: latest.p4 ?? 0 },
      { key: 'p5', name: 'P5', desc: '漂移', value: latest.p5 ?? 0 },
      { key: 'p6', name: 'P6', desc: '新奇度', value: latest.p6 ?? 0 },
      { key: 'p7', name: 'P7', desc: '孤独感', value: latest.p7 ?? 0 },
      { key: 'p8', name: 'P8', desc: '被遗忘', value: latest.p8 ?? 0 },
      { key: 'pProspect', name: 'PROS', desc: '预期', value: latest.pProspect ?? 0 },
      { key: 'api', name: 'API', desc: '总体压力', value: latest.api ?? 0 },
    ];

    function colorClass(v) {
      if (v < 0.3) return 'param-low';
      if (v < 0.65) return 'param-mid';
      return 'param-high';
    }

    let html = '';
    for (const p of params) {
      html += `<div class="param-card">`;
      html += `<div class="param-name">${p.name} <span style="font-size:9px">${p.desc}</span></div>`;
      html += `<div class="param-value ${colorClass(p.value)}">${p.value.toFixed(3)}</div>`;
      html += `</div>`;
    }

    html += `<div class="param-card">`;
    html += `<div class="param-name">Tick</div>`;
    html += `<div class="param-value" style="font-size:16px">#${latest.tick ?? '?'}</div>`;
    html += `<div class="param-desc">峰值: ${(latest.apiPeak ?? 0).toFixed(3)}</div>`;
    html += `</div>`;

    this.paramsContainer.innerHTML = html;
  }

  renderTimeline() {
    if (!this.timelineChart) return;

    const cutoff = Date.now() - this.timeRange;
    const filtered = this.snapshots.filter((s) => s.createdMs >= cutoff).reverse();

    if (filtered.length === 0) {
      this.timelineChart.setOption({ series: [] }, true);
      return;
    }

    const timeData = filtered.map((s) => {
      const d = new Date(s.createdMs);
      return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
    });

    const pressureKeys = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'api'];
    const colors = ['#4f46e5', '#e74c3c', '#f39c12', '#27ae60', '#3498db', '#9b59b6', '#1abc9c', '#e67e22', '#95a5a6'];
    const names = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'API'];

    const series = pressureKeys.map((key, i) => ({
      name: names[i],
      type: 'line',
      data: filtered.map((s) => s[key] ?? 0),
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 1.5, color: colors[i] },
      emphasis: { focus: 'series' },
    }));

    const option = {
      tooltip: {
        trigger: 'axis',
        formatter: (params) => {
          const time = params[0]?.axisValue ?? '';
          const items = params.map((p) => `${p.marker} ${p.seriesName}: ${p.value?.toFixed(3)}`).join('<br/>');
          return `${time}<br/>${items}`;
        },
      },
      legend: {
        data: names,
        bottom: 0,
        textStyle: { fontSize: 10, color: 'var(--text-secondary)' },
        itemWidth: 15,
        itemHeight: 2,
      },
      grid: { left: 40, right: 15, top: 10, bottom: 30 },
      xAxis: {
        type: 'category',
        data: timeData,
        axisLabel: { fontSize: 10, color: 'var(--text-muted)', rotate: 45 },
        axisLine: { lineStyle: { color: 'var(--border)' } },
      },
      yAxis: {
        type: 'value', min: 0, max: 1,
        axisLabel: { fontSize: 10, color: 'var(--text-muted)' },
        splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      },
      series,
    };

    this.timelineChart.setOption(option, true);
  }

  resize() {
    this.timelineChart?.resize();
  }
}
