/* Shared admin poll controls (used by dashboard and polls pages) */
(function () {
  'use strict';
  const { API, toast, confirmDialog, escapeHtml, statusPill, formatClock, formatDate, setBusy } = window.App;

  function visibilityLabel(mode) {
    return mode === 'during' ? 'Live during voting' : mode === 'after' ? 'After closing' : 'Never (private)';
  }

  function controlButtons(poll) {
    const b = [];
    const st = poll.status;
    if (st === 'draft') {
      b.push(`<button class="btn btn-primary" data-poll-act="start" data-id="${poll.id}">▶ Start poll</button>`);
    }
    if (st === 'active') {
      b.push(`<button class="btn btn-gold" data-poll-act="pause" data-id="${poll.id}">⏸ Pause</button>`);
      b.push(`<button class="btn btn-ghost" data-poll-act="extend" data-id="${poll.id}">+30s</button>`);
      b.push(`<button class="btn btn-ghost" data-poll-act="close" data-id="${poll.id}">■ Close</button>`);
    }
    if (st === 'paused') {
      b.push(`<button class="btn btn-primary" data-poll-act="resume" data-id="${poll.id}">▶ Resume</button>`);
      b.push(`<button class="btn btn-ghost" data-poll-act="close" data-id="${poll.id}">■ Close</button>`);
    }
    if (st === 'closed') {
      b.push(`<button class="btn btn-primary" data-poll-act="reopen" data-id="${poll.id}">↻ Reopen</button>`);
    }
    b.push(`<button class="btn btn-ghost" data-poll-act="reset" data-id="${poll.id}">⟲ Reset votes</button>`);
    b.push(`<button class="btn btn-ghost" data-poll-act="edit" data-id="${poll.id}">✏️ Edit</button>`);
    b.push(`<button class="btn btn-ghost" data-poll-act="export" data-id="${poll.id}">⬇ CSV</button>`);
    b.push(`<button class="btn btn-danger" data-poll-act="delete" data-id="${poll.id}">🗑 Delete</button>`);
    return b.join('');
  }

  async function handleAction(act, id, ctx = {}) {
    const poll = (window.AdminShell.state?.polls || []).find((p) => p.id === Number(id)) || ctx.poll;
    try {
      if (act === 'start' || act === 'reopen') {
        const ok = await confirmDialog({
          title: act === 'start' ? 'Start this poll now?' : 'Reopen this poll?',
          message:
            'Every participant device will instantly show this poll. Any other live poll will be paused automatically.' +
            (poll?.totalVotes ? '<br /><br />This poll already has votes — reopen it only if you want to allow more voting.' : ''),
          confirmText: act === 'start' ? 'Start poll' : 'Reopen'
        });
        if (!ok) return;
        await API.post(`/api/admin/polls/${id}/action`, {
          action: act,
          timerSeconds: poll?.timerSeconds
        });
        toast('Poll is live now', 'ok');
      } else if (act === 'pause') {
        await API.post(`/api/admin/polls/${id}/action`, { action: 'pause' });
        toast('Poll paused', 'info');
      } else if (act === 'resume') {
        await API.post(`/api/admin/polls/${id}/action`, { action: 'resume' });
        toast('Poll resumed', 'ok');
      } else if (act === 'close') {
        const ok = await confirmDialog({
          title: 'Close this poll?',
          message: 'Voting stops immediately. Final results follow your visibility setting.',
          confirmText: 'Close poll'
        });
        if (!ok) return;
        await API.post(`/api/admin/polls/${id}/action`, { action: 'close' });
        toast('Poll closed', 'ok');
      } else if (act === 'extend') {
        await API.post(`/api/admin/polls/${id}/action`, { action: 'extend', seconds: 30 });
        toast('Timer extended by 30s', 'ok');
      } else if (act === 'reset') {
        const ok = await confirmDialog({
          title: 'Reset this poll?',
          message:
            'This permanently deletes <strong>all votes</strong> for this poll and returns it to draft. Participants will be able to vote again. This cannot be undone.',
          confirmText: 'Reset poll',
          danger: true
        });
        if (!ok) return;
        await API.post(`/api/admin/polls/${id}/action`, { action: 'reset', confirm: true });
        toast('Poll reset — votes cleared', 'ok');
      } else if (act === 'delete') {
        const ok = await confirmDialog({
          title: 'Delete this poll?',
          message: `This removes the poll and its ${poll?.totalVotes || 0} vote(s) permanently.`,
          confirmText: 'Delete',
          danger: true
        });
        if (!ok) return;
        await API.del(`/api/admin/polls/${id}`);
        toast('Poll deleted', 'ok');
      } else if (act === 'export') {
        window.location.href = `/api/admin/export/poll/${id}.csv`;
        return;
      } else if (act === 'edit') {
        if (ctx.onEdit) ctx.onEdit(poll);
        return;
      } else if (act === 'visibility') {
        await API.post(`/api/admin/polls/${id}/action`, {
          action: 'visibility',
          showResults: ctx.mode
        });
        toast(`Results: ${visibilityLabel(ctx.mode)}`, 'ok');
      }
      await window.AdminShell.refresh();
      window.AdminShell.poke && window.AdminShell.poke();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function resultsHtml(results, { max = 8 } = {}) {
    if (!results || !results.rows.length) return '<div class="empty">No votes yet</div>';
    return results.rows
      .slice(0, max)
      .map(
        (r) => `
      <div class="result-row ${results.leadingOptionId === r.optionId ? 'is-leader' : ''}">
        <div class="result-top">
          <span class="result-label">${r.emoji ? escapeHtml(r.emoji) + ' ' : ''}${escapeHtml(r.label)}</span>
          <span class="result-votes">${r.votes}</span>
          <span class="result-pct">${r.percent}%</span>
        </div>
        <div class="bar-track"><div class="bar-fill" data-w="${r.percent}"></div></div>
      </div>`
      )
      .join('');
  }

  function animateBars(root) {
    requestAnimationFrame(() => {
      (root || document).querySelectorAll('.bar-fill[data-w]').forEach((b) => {
        b.style.width = `${b.dataset.w}%`;
      });
    });
  }

  function bindActions(root, ctx = {}) {
    root.querySelectorAll('[data-poll-act]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handleAction(btn.dataset.pollAct, btn.dataset.id, ctx);
      });
    });
    root.querySelectorAll('[data-visibility]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handleAction('visibility', btn.dataset.id, { mode: btn.dataset.visibility, onEdit: ctx.onEdit });
      });
    });
  }

  function metaChips(poll) {
    return `
      ${statusPill(poll.status)}
      <span class="pill pill-ghost">🗳️ ${poll.totalVotes} votes</span>
      <span class="pill pill-ghost">⏱ ${poll.timerSeconds ? poll.timerSeconds + 's' : 'No timer'}</span>
      <span class="pill pill-ghost">${poll.anonymous ? '🕶️ Anonymous' : '👤 Named'}</span>
      <span class="pill pill-ghost">👁 ${visibilityLabel(poll.showResults)}</span>
      ${poll.category ? `<span class="pill pill-ghost">${escapeHtml(poll.category)}</span>` : ''}
    `;
  }

  window.AdminPollUI = {
    controlButtons,
    handleAction,
    resultsHtml,
    metaChips,
    animateBars,
    bindActions,
    visibilityLabel,
    formatDate,
    formatClock
  };
})();
