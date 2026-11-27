// Draws a doomscroll run report (kind "run") or the list of runs with the
// side-by-side comparison (kind "index") from the JSON embedded in the page.
(() => {
    'use strict';
    const { kind, runs } = JSON.parse(document.getElementById('data').textContent);
    const root = document.getElementById('app');
    const tooltip = document.getElementById('tooltip');
    // Compare slots: the first three categorical hues (they validate all-pairs in both themes).
    const SLOT_COLORS = ['var(--capture)', 'var(--model)', 'var(--ocr)'];
    const SOURCES = { runner: 'CLI runner', warmup: 'Warm-up', mcp: 'Claude (MCP)' };

    const esc = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const tip = (lines) => esc(lines.filter((line) => line !== undefined && line !== '').join('\n')).replace(/\n/g, '&#10;');
    function fmt(ms) {
        if (ms === undefined || ms === null || !Number.isFinite(ms)) return '–';
        const abs = Math.abs(ms);
        if (abs < 1000) return `${Math.round(ms)} ms`;
        return `${(ms / 1000).toFixed(abs < 10000 ? 2 : 1)} s`;
    }
    function quantile(values, p) {
        if (!values.length) return undefined;
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
    }
    const dur = (span) => (span ? span[1] - span[0] : undefined);
    const niceCeil = (ms) => (ms <= 5000 ? Math.ceil(ms / 500) * 500 : Math.ceil(ms / 1000) * 1000);
    const niceStep = (range) => (range <= 2000 ? 250 : range <= 4000 ? 500 : range <= 8000 ? 1000 : range <= 16000 ? 2000 : 5000);
    const judged = (video) => !video.auto;

    function runDate(run) {
        const iso = run.startedAt ?? run.id.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z');
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? run.id : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    const runLabel = (run) => `${runDate(run)} · ${run.app}${run.account ? ` ${run.account}` : ''}`;
    function settingsText(run) {
        const s = run.settings;
        if (!s) return 'settings not recorded';
        return [`settle ${s.settleMs ?? '?'} ms`, s.earlyDecide === undefined ? undefined : `early model call ${s.earlyDecide ? 'on' : 'off'}`]
            .filter(Boolean).join(' · ');
    }
    const hasSpans = (run) => run.videos.some((video) => video.spans);

    const METRICS = [
        { key: 'ttd', label: 'Time to decision', hint: 'Swipe landed → plan ready, for videos the model judged. The headline latency.', get: (v) => (judged(v) && v.spans ? v.spans.decided : undefined) },
        { key: 'settle', label: 'Settle wait', hint: 'Wait before the screenshot (AGENT_SETTLE_MS).', get: (v) => (v.spans ? (dur(v.spans.settle) ?? 0) : undefined) },
        { key: 'screenshot', label: 'Screenshot', hint: 'WDA screenshot round trip.', get: (v) => dur(v.spans?.screenshot) },
        { key: 'images', label: 'Image prep', hint: 'Shrinking the screenshot and cropping the caption for the model.', get: (v) => dur(v.spans?.images) },
        { key: 'ocr', label: 'Caption OCR', hint: 'Reading the caption (code-side ad and same-video checks).', get: (v) => dur(v.spans?.ocr) },
        { key: 'inspect', label: 'App checks', hint: "The app's own checks on the screenshot: ads, cards, reel id.", get: (v) => dur(v.spans?.inspect) },
        { key: 'model', label: 'Model call', hint: 'One OpenRouter call (retry included). Absent for Claude (MCP) runs.', get: (v) => (judged(v) ? v.modelMs : undefined) },
        { key: 'late', label: 'Swipe held by model', hint: 'Skips only: how long after the planned swipe time the plan arrived (0 = the model was not in the way).', get: (v) => (v.watch === 'skip' && judged(v) && v.spans && v.watchMs !== undefined ? Math.max(0, v.spans.decided - v.watchMs) : undefined) },
        { key: 'skipScreen', label: 'Skip: time on screen', hint: 'Skips the model judged: swipe landed → next swipe landed.', get: (v) => (v.watch === 'skip' && judged(v) ? v.screenMs : undefined) },
    ];

    function stats(run, metric) {
        const points = run.videos.flatMap((video) => {
            const value = metric.get(video);
            return value === undefined || value === null || !Number.isFinite(value) ? [] : [{ value, video }];
        });
        const values = points.map((point) => point.value);
        return { points, n: values.length, median: quantile(values, 0.5), p90: quantile(values, 0.9), p95: quantile(values, 0.95), max: values.length ? Math.max(...values) : undefined };
    }

    // ---------- tooltip ----------
    document.addEventListener('mousemove', (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-tip]') : null;
        if (!target) {
            tooltip.hidden = true;
            return;
        }
        tooltip.textContent = target.getAttribute('data-tip');
        tooltip.hidden = false;
        const pad = 14;
        const box = tooltip.getBoundingClientRect();
        let x = event.clientX + pad;
        let y = event.clientY + pad;
        if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
        if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
        tooltip.style.left = `${Math.max(8, x)}px`;
        tooltip.style.top = `${Math.max(8, y)}px`;
    });
    document.addEventListener('mouseleave', () => { tooltip.hidden = true; });

    // ---------- shared pieces ----------
    const HATCH = '<pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
        + '<rect width="5" height="5" style="fill:var(--surface-1)"/><line x1="0" y1="0" x2="0" y2="5" style="stroke:var(--wait-line);stroke-width:1.6"/></pattern>';
    const swatch = (style, extra = '') => `<svg width="14" height="10" aria-hidden="true">${extra}<rect x="0.5" y="0.5" width="13" height="9" rx="2" style="${style}"/></svg>`;

    function tile(label, value, extra) {
        return `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="extra">${esc(extra ?? '')}</div></div>`;
    }

    // ---------- waterfall ----------
    function waterfall(run) {
        const videos = run.videos.filter((video) => video.spans);
        if (!videos.length) return '';
        const W = 760, L = 92, R = 64, top = 22, rowH = 26, plotW = W - L - R;
        const windowMs = Math.min(15000, Math.max(3000, niceCeil(quantile(videos.map((v) => v.spans.end), 0.75))));
        const x = (ms) => L + (Math.max(0, Math.min(ms, windowMs)) / windowMs) * plotW;
        const height = top + videos.length * rowH + 6;
        const step = niceStep(windowMs);
        let svg = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="Where each video's time went"><defs>${HATCH}</defs>`;
        for (let t = 0; t <= windowMs; t += step) {
            svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 4}" y2="${height - 4}" style="stroke:var(--grid);stroke-width:1"/>`;
            svg += `<text x="${x(t)}" y="12" text-anchor="middle">${t === 0 ? '0' : fmt(t)}</text>`;
        }
        const seg = (span, y, h, style) => {
            if (!span || span[1] <= span[0]) return '';
            let x1 = x(span[0]);
            let x2 = x(span[1]);
            if (x2 - x1 > 3) { x1 += 1; x2 -= 1; }
            if (x2 - x1 < 1) x2 = x1 + 1;
            return `<rect x="${x1.toFixed(1)}" y="${y}" width="${(x2 - x1).toFixed(1)}" height="${h}" rx="2" style="${style}"/>`;
        };
        videos.forEach((v, i) => {
            const s = v.spans;
            const y0 = top + i * rowH;
            const my = y0 + 4;
            const mh = 10;
            const captureEnd = s.images[1];
            const watchEnd = s.swipe ? s.swipe[0] : s.end;
            let row = '';
            row += seg(s.settle, my, mh, 'fill:url(#hatch)');
            row += seg([s.screenshot[0], captureEnd], my, mh, 'fill:var(--capture)');
            row += seg([captureEnd, s.decided], my, mh, 'fill:url(#hatch)');
            row += seg([s.decided, watchEnd], my, mh, 'fill:var(--watch)');
            for (const extra of [s.follow, s.accountCheck, s.search]) {
                if (extra) row += seg(extra, my, mh, 'fill:none;stroke:var(--text-secondary);stroke-width:1.5');
            }
            row += seg(s.swipe, my, mh, 'fill:var(--swipe)');
            for (const action of s.actions ?? []) {
                const ax = x(action.at[0]);
                row += `<line x1="${ax}" x2="${ax}" y1="${my - 2}" y2="${my + mh + 2}" style="stroke:var(--text-primary);stroke-width:2"/>`;
            }
            row += seg(s.model, y0 + 16, 3, 'fill:var(--model)');
            row += seg([s.screenshot[1], Math.max(s.ocr[1], s.inspect[1])], y0 + 20, 3, 'fill:var(--ocr)');
            const plan = v.auto ? `auto: ${v.auto}` : (v.watch ?? '');
            row += `<text x="${L - 8}" y="${y0 + 13}" text-anchor="end"><tspan class="strong">#${v.video}</tspan> ${esc(plan.length > 10 ? plan.slice(0, 10) : plan)}</text>`;
            row += `<text x="${W - R + 6}" y="${y0 + 13}">${s.end > windowMs ? '→ ' : ''}${fmt(s.end)}</text>`;
            const lines = [
                `#${v.video} · ${v.auto ? `auto-skip: ${v.auto}` : `${v.watch} · on-niche ${v.onNiche ?? '?'}`}${v.place === 'search' ? ' · search' : ''}`,
                v.caption ? v.caption.slice(0, 90) : undefined,
                ' ',
                `Time to decision   ${fmt(s.decided)}`,
                s.settle ? `Settle wait   ${fmt(dur(s.settle))}` : undefined,
                `Screenshot   ${fmt(dur(s.screenshot))}`,
                `Image prep   ${fmt(dur(s.images))}`,
                `Caption OCR   ${fmt(dur(s.ocr))}`,
                `App checks   ${fmt(dur(s.inspect))}`,
                s.model ? `Model call   ${fmt(dur(s.model))}  (${fmt(s.model[0])} → ${fmt(s.model[1])})${v.provider ? ` · ${v.provider}` : ''}` : undefined,
                v.watchMs !== undefined ? `Planned on screen   ${fmt(v.watchMs)}` : undefined,
                (s.actions ?? []).length ? `Actions   ${s.actions.map((a) => `${a.kind} at ${fmt(a.at[0])}`).join(', ')}` : undefined,
                s.follow ? `Follow   ${fmt(dur(s.follow))}` : undefined,
                s.accountCheck ? `Account check   ${fmt(dur(s.accountCheck))}` : undefined,
                s.search ? `Search detour   ${fmt(dur(s.search))}` : undefined,
                s.swipe ? `Swipe   ${fmt(dur(s.swipe))}` : undefined,
                `On screen   ${fmt(s.end)}`,
                v.retries ? `After ${v.retries} retried swipe(s)` : undefined,
            ];
            row += `<rect x="0" y="${y0}" width="${W}" height="${rowH}" style="fill:transparent" data-tip="${tip(lines)}"/>`;
            svg += row;
        });
        svg += '</svg>';
        const legend = `<div class="legend">
            <span>${swatch('fill:url(#hatch-legend)', `<defs>${HATCH.replace('id="hatch"', 'id="hatch-legend"')}</defs>`)}Waiting (settle, OCR, model)</span>
            <span>${swatch('fill:var(--capture)')}Capture (screenshot + image prep)</span>
            <span>${swatch('fill:var(--watch)')}Watching</span>
            <span>${swatch('fill:var(--swipe)')}Swipe</span>
            <span>${swatch('fill:none;stroke:var(--text-secondary);stroke-width:1.5')}Follow / account check / search</span>
            <span><svg width="14" height="10" aria-hidden="true"><line x1="7" x2="7" y1="0" y2="10" style="stroke:var(--text-primary);stroke-width:2"/></svg>Like / save / comment</span>
            <span><svg width="14" height="10" aria-hidden="true"><rect y="3" width="14" height="3" rx="1" style="fill:var(--model)"/></svg>Model call</span>
            <span><svg width="14" height="10" aria-hidden="true"><rect y="3" width="14" height="3" rx="1" style="fill:var(--ocr)"/></svg>Caption OCR + app checks</span>
        </div>`;
        return `<section class="card"><h2>Where each video's time went</h2>
            <p class="hint">One row per video, from the swipe landing (0) to the next swipe landing. The thin lines under each bar run alongside it.
            Rows past ${fmt(windowMs)} are cut (→). Hover a row for every step.</p>${legend}<div class="scroll">${svg}</div></section>`;
    }

    // ---------- distributions ----------
    function strips(list, colors) {
        const metrics = METRICS.filter((metric) => list.some((run) => stats(run, metric).n));
        if (!metrics.length) return '';
        const W = 760, L = 150, R = 150, plotW = W - L - R, sub = 20, pad = 10, top = 6;
        const rowH = list.length * sub + pad * 2;
        const p95s = metrics.flatMap((metric) => list.map((run) => stats(run, metric).p95 ?? 0));
        const xmax = Math.max(500, niceCeil(Math.max(...p95s) * 1.05));
        const x = (ms) => L + (Math.min(Math.max(ms, 0), xmax) / xmax) * plotW;
        const height = top + metrics.length * rowH + 22;
        let svg = `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="Step time distributions">`;
        const step = niceStep(xmax);
        for (let t = 0; t <= xmax; t += step) {
            svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - 20}" style="stroke:var(--grid);stroke-width:1"/>`;
            svg += `<text x="${x(t)}" y="${height - 6}" text-anchor="middle">${t === 0 ? '0' : fmt(t)}</text>`;
        }
        metrics.forEach((metric, m) => {
            const y0 = top + m * rowH;
            if (m > 0) svg += `<line x1="0" x2="${W}" y1="${y0}" y2="${y0}" style="stroke:var(--border);stroke-width:1"/>`;
            svg += `<text x="0" y="${y0 + rowH / 2 + 4}" class="strong" data-tip="${tip([metric.label, metric.hint])}">${esc(metric.label)}</text>`;
            list.forEach((run, r) => {
                const st = stats(run, metric);
                const cy = y0 + pad + r * sub + sub / 2;
                const color = colors[r];
                st.points.forEach((point, i) => {
                    const jitter = (((i * 7919) % 9) - 4) * 1.1;
                    const clipped = point.value > xmax;
                    svg += `<circle cx="${x(point.value).toFixed(1)}" cy="${(cy + jitter).toFixed(1)}" r="4" style="fill:${clipped ? 'var(--surface-1)' : color};fill-opacity:${clipped ? 1 : 0.55};stroke:${clipped ? color : 'var(--surface-1)'};stroke-width:${clipped ? 2 : 1}" data-tip="${tip([
                        `${metric.label}: ${fmt(point.value)}${clipped ? ' (off the axis)' : ''}`,
                        `#${point.video.video} · ${point.video.auto ? `auto: ${point.video.auto}` : point.video.watch}`,
                        list.length > 1 ? runLabel(run) : undefined,
                    ])}"/>`;
                });
                if (st.median !== undefined) {
                    const mx = x(st.median);
                    svg += `<line x1="${mx}" x2="${mx}" y1="${cy - 8}" y2="${cy + 8}" style="stroke:var(--text-primary);stroke-width:2"/>`;
                }
                svg += `<text x="${W - R + 10}" y="${cy + 4}">${st.n ? `<tspan class="strong">${fmt(st.median)}</tspan> · p90 ${fmt(st.p90)}` : 'not recorded'}</text>`;
            });
        });
        svg += '</svg>';
        const legend = list.length > 1
            ? `<div class="legend">${list.map((run, r) => `<span>${swatch(`fill:${colors[r]}`)}${esc(runLabel(run))} · ${esc(settingsText(run))}</span>`).join('')}
               <span><svg width="14" height="14" aria-hidden="true"><line x1="7" x2="7" y1="0" y2="14" style="stroke:var(--text-primary);stroke-width:2"/></svg>Median</span></div>`
            : '<div class="legend"><span><svg width="14" height="14" aria-hidden="true"><line x1="7" x2="7" y1="0" y2="14" style="stroke:var(--text-primary);stroke-width:2"/></svg>Median</span><span>Hollow dot: past the axis</span></div>';
        return `<section class="card"><h2>Step times</h2><p class="hint">One dot per video; numbers on the right are median · p90. Hover a step name for what it measures.</p>${legend}<div class="scroll">${svg}</div></section>`;
    }

    // ---------- run page ----------
    function kpis(run) {
        const ttd = stats(run, METRICS[0]);
        const model = stats(run, METRICS.find((m) => m.key === 'model'));
        const skip = stats(run, METRICS.find((m) => m.key === 'skipScreen'));
        const late = stats(run, METRICS.find((m) => m.key === 'late'));
        const held = late.points.filter((p) => p.value > 0).length;
        return `<div class="tiles">
            ${tile('Time to decision (median)', ttd.n ? fmt(ttd.median) : '–', ttd.n ? `p90 ${fmt(ttd.p90)} · ${ttd.n} videos` : 'not recorded in this run')}
            ${tile('Model call (median)', model.n ? fmt(model.median) : '–', model.n ? `p90 ${fmt(model.p90)}` : run.source === 'mcp' ? 'Claude decides (MCP)' : 'not recorded')}
            ${tile('Skip: time on screen (median)', skip.n ? fmt(skip.median) : '–', skip.n ? `p90 ${fmt(skip.p90)} · ${skip.n} skips` : 'no judged skips')}
            ${tile('Skips held by the model', late.n ? `${held} of ${late.n}` : '–', late.n ? `median hold ${fmt(late.median)} · p90 ${fmt(late.p90)}` : 'not recorded in this run')}
        </div>`;
    }

    function videoTable(run) {
        const rows = run.videos.map((v) => {
            const s = v.spans;
            const plan = v.auto ? `auto: ${v.auto}` : `${v.watch ?? ''} ${v.onNiche ?? ''}`;
            const acts = [v.liked && 'like', v.saved && 'save', v.commented && 'comment', v.followed && 'follow'].filter(Boolean).join(' ');
            return `<tr><td class="num">${v.video}</td><td>${esc(plan)}${acts ? ` · ${acts}` : ''}</td>
                <td class="num">${fmt(s?.decided)}</td><td class="num">${fmt(dur(s?.screenshot))}</td><td class="num">${fmt(dur(s?.ocr))}</td>
                <td class="num">${fmt(v.modelMs)}</td><td class="num">${fmt(v.screenMs)}</td><td>${esc(v.provider ?? '')}</td><td class="caption">${esc(v.caption)}</td></tr>`;
        }).join('');
        return `<section class="card"><details><summary>All videos (${run.videos.length})</summary><div class="scroll"><table>
            <thead><tr><th class="num">#</th><th>Plan</th><th class="num">Time to decision</th><th class="num">Screenshot</th><th class="num">OCR</th><th class="num">Model</th><th class="num">On screen</th><th>Provider</th><th>Caption</th></tr></thead>
            <tbody>${rows}</tbody></table></div></details></section>`;
    }

    function runPage(run) {
        const meta = [
            runDate(run), SOURCES[run.source] ?? 'started by: not recorded', run.personality, run.model, settingsText(run),
            `${run.videos.length} videos`, run.elapsedMs ? (run.elapsedMs < 60000 ? `${Math.round(run.elapsedMs / 1000)} s` : `${Math.round(run.elapsedMs / 60000)} min`) : undefined, run.reason,
        ].filter(Boolean).join(' · ');
        const older = hasSpans(run) ? '' : '<p class="hint">This run was recorded before step timings existed: only the model call and time on screen are known.</p>';
        root.innerHTML = `<p class="hint"><a href="../index.html">← All runs</a></p>
            <h1>${esc(run.app)}${run.account ? ` · ${esc(run.account)}` : ''}</h1><p class="sub">${esc(meta)}</p>${older}
            ${kpis(run)}${waterfall(run)}${strips([run], [SLOT_COLORS[0]])}${videoTable(run)}`;
    }

    // ---------- index page ----------
    function indexPage() {
        const slots = new Map();
        const pickDefault = runs.filter((run) => hasSpans(run)).slice(0, 2);
        (pickDefault.length ? pickDefault : runs.filter((run) => run.videos.length).slice(0, 1)).forEach((run, i) => slots.set(run.id, i));
        const filters = { app: '', source: '' };
        const apps = [...new Set(runs.map((run) => run.app))].sort();
        // 'none' = runs recorded before the source was (the filter's '' means all).
        const sourceOf = (run) => run.source ?? 'none';
        const sources = [...new Set(runs.map(sourceOf))].sort();

        function compareTable(list) {
            const metrics = METRICS.filter((metric) => list.some((run) => stats(run, metric).n));
            const head = list.map((run) => `<th class="num"><span class="swatch" style="background:${SLOT_COLORS[slots.get(run.id)]}"></span>${esc(runLabel(run))}<br><span style="font-weight:400">${esc(settingsText(run))}</span></th>`).join('');
            const body = metrics.map((metric) => {
                const base = stats(list[0], metric).median;
                const cells = list.map((run, r) => {
                    const st = stats(run, metric);
                    if (!st.n) return '<td class="num">–</td>';
                    let delta = '';
                    if (r > 0 && base !== undefined) {
                        const d = st.median - base;
                        const sign = d > 0 ? '+' : d < 0 ? '−' : '±';
                        const share = base ? ` (${d ? sign : ''}${Math.round(Math.abs(d / base) * 100)}%)` : '';
                        delta = `<br><span style="color:var(--text-secondary)">${sign}${fmt(Math.abs(d))}${share} vs first</span>`;
                    }
                    return `<td class="num">${fmt(st.median)} <span style="color:var(--text-secondary)">· p90 ${fmt(st.p90)}</span>${delta}</td>`;
                }).join('');
                return `<tr><td data-tip="${tip([metric.label, metric.hint])}">${esc(metric.label)}</td>${cells}</tr>`;
            }).join('');
            return `<div class="scroll"><table><thead><tr><th>Median</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
        }

        function render() {
            // Oldest first, so the deltas read "after vs before".
            const selected = runs.filter((run) => slots.has(run.id)).sort((a, b) => a.id.localeCompare(b.id));
            const visible = runs.filter((run) => (!filters.app || run.app === filters.app) && (!filters.source || sourceOf(run) === filters.source));
            const full = slots.size >= 3;
            const ttdMetric = METRICS[0];
            const skipMetric = METRICS.find((m) => m.key === 'skipScreen');
            const modelMetric = METRICS.find((m) => m.key === 'model');
            const rows = visible.map((run) => {
                const on = slots.has(run.id);
                return `<tr${run.videos.length ? '' : ' class="off"'}>
                    <td><input type="checkbox" data-run="${esc(run.id)}" ${on ? 'checked' : ''} ${!on && full ? 'disabled' : ''} aria-label="Compare ${esc(runLabel(run))}">
                        ${on ? `<span class="swatch" style="background:${SLOT_COLORS[slots.get(run.id)]}"></span>` : ''}</td>
                    <td><a href="${encodeURI(run.id)}/report.html" data-tip="Open this run's report">${esc(runDate(run))}</a></td><td>${esc(run.app)}</td><td>${esc(run.account ?? '')}</td><td>${esc(SOURCES[run.source] ?? '–')}</td>
                    <td class="num">${run.videos.length}</td><td>${esc(run.settings ? settingsText(run) : '–')}</td>
                    <td class="num">${fmt(stats(run, ttdMetric).median)}</td><td class="num">${fmt(stats(run, skipMetric).median)}</td><td class="num">${fmt(stats(run, modelMetric).median)}</td></tr>`;
            }).join('');
            const select = (name, values, label) => `<label>${label} <select data-filter="${name}"><option value="">All</option>${values.map((value) => `<option value="${esc(value)}" ${filters[name] === value ? 'selected' : ''}>${esc(name === 'source' ? (SOURCES[value] ?? 'not recorded') : value)}</option>`).join('')}</select></label>`;
            root.innerHTML = `<h1>Doomscroll runs</h1><p class="sub">${runs.length} runs in .agent-runs · tick up to three to compare them</p>
                <section class="card"><div class="filters">${select('app', apps, 'App')}${select('source', sources, 'Started by')}</div>
                <div class="scroll"><table><thead><tr><th></th><th>Started</th><th>App</th><th>Account</th><th>Started by</th><th class="num">Videos</th><th>Latency settings</th>
                <th class="num">Time to decision</th><th class="num">Skip on screen</th><th class="num">Model call</th></tr></thead><tbody>${rows}</tbody></table></div>
                <p class="hint" style="margin-top:8px">Medians. Time to decision is only known for runs with step timings.</p></section>
                ${selected.length ? `<section class="card"><h2>Comparison</h2><p class="hint">Oldest run first; deltas are against it.</p>${compareTable(selected)}</section>${strips(selected, selected.map((run) => SLOT_COLORS[slots.get(run.id)]))}` : ''}`;
        }

        root.addEventListener('change', (event) => {
            const target = event.target;
            if (target.matches('input[data-run]')) {
                const id = target.getAttribute('data-run');
                if (target.checked) {
                    const used = new Set(slots.values());
                    const free = [0, 1, 2].find((slot) => !used.has(slot));
                    if (free !== undefined) slots.set(id, free);
                } else {
                    slots.delete(id);
                }
                render();
            } else if (target.matches('select[data-filter]')) {
                filters[target.getAttribute('data-filter')] = target.value;
                render();
            }
        });
        render();
    }

    if (kind === 'run' && runs[0]) runPage(runs[0]);
    else indexPage();
})();
