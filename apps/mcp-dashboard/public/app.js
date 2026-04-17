const state = {
  dashboard: null,
  selectedRunId: null,
  selectedRun: null,
  selectedArtifactId: null,
  jobs: []
};

const els = {
  lastUpdated: document.querySelector("#lastUpdated"),
  refreshButton: document.querySelector("#refreshButton"),
  promptForm: document.querySelector("#promptForm"),
  promptInput: document.querySelector("#promptInput"),
  startRunButton: document.querySelector("#startRunButton"),
  jobStatus: document.querySelector("#jobStatus"),
  serverState: document.querySelector("#serverState"),
  runList: document.querySelector("#runList"),
  processMap: document.querySelector("#processMap"),
  selectedRunTitle: document.querySelector("#selectedRunTitle"),
  runMetrics: document.querySelector("#runMetrics"),
  screenshotFrame: document.querySelector("#screenshotFrame"),
  stepTimeline: document.querySelector("#stepTimeline"),
  artifactList: document.querySelector("#artifactList"),
  artifactTitle: document.querySelector("#artifactTitle"),
  artifactPreview: document.querySelector("#artifactPreview"),
  toolGroups: document.querySelector("#toolGroups"),
  resourceList: document.querySelector("#resourceList"),
  promptList: document.querySelector("#promptList")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) {
    return "Not finished";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function statusPill(status) {
  return `<span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function metricValueClass(label) {
  return ["Started", "Updated"].includes(label) ? "metric-value long" : "metric-value";
}

function jsonSnippet(value) {
  return escapeHtml(JSON.stringify(value ?? {}, null, 2));
}

function renderValidationRecord(validation) {
  const evidence = validation.evidence?.length
    ? `<p class="meta">Evidence: ${escapeHtml(validation.evidence.join(" · "))}</p>`
    : "";
  const source = validation.sourceUrl
    ? `<a href="${escapeHtml(validation.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(validation.sourceUrl)}</a>`
    : "";
  const confidence = typeof validation.confidence === "number"
    ? `<span class="meta">confidence ${Math.round(validation.confidence * 100)}%</span>`
    : "";

  return `
    <div class="validation-item ${escapeHtml(validation.status)}">
      <div class="validation-head">
        <strong>${escapeHtml(validation.title)}</strong>
        <span class="validation-kind">${escapeHtml(validation.kind)}</span>
        ${statusPill(validation.status)}
      </div>
      <p>${escapeHtml(validation.summary)}</p>
      ${evidence}
      <div class="validation-foot">
        ${source}
        ${confidence}
      </div>
    </div>
  `;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function loadState() {
  els.refreshButton.disabled = true;
  try {
    state.dashboard = await fetchJson("/api/state");
    state.jobs = state.dashboard.jobs ?? state.jobs;
    state.selectedRunId = state.selectedRunId ?? state.dashboard.latestRunId ?? state.dashboard.runs?.[0]?.runId ?? null;
    await loadSelectedRun();
    render();
  } catch (error) {
    els.lastUpdated.textContent = `Load failed: ${error.message}`;
  } finally {
    els.refreshButton.disabled = false;
  }
}

async function loadJobs() {
  const result = await fetchJson("/api/agent-jobs");
  state.jobs = result.jobs ?? [];
  renderJobs();
}

async function loadSelectedRun() {
  if (!state.selectedRunId) {
    state.selectedRun = null;
    return;
  }
  state.selectedRun = await fetchJson(`/api/runs/${encodeURIComponent(state.selectedRunId)}`);
}

function renderServerState() {
  const server = state.dashboard?.server;
  if (!server) {
    els.serverState.innerHTML = '<div class="empty">No server state loaded.</div>';
    return;
  }

  els.serverState.innerHTML = [
    ["Name", server.name],
    ["Transport", server.transport],
    ["Runtime", server.runtimeRoot],
    ["Artifacts", server.artifactsRoot],
    ["Chrome Profile", server.chromeProfileDir]
  ]
    .map(
      ([label, value]) => `
        <div class="state-row">
          <strong>${escapeHtml(label)}</strong>
          <span class="path-text">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderRuns() {
  const runs = state.dashboard?.runs ?? [];
  if (runs.length === 0) {
    els.runList.innerHTML = '<div class="empty">No recorded runs yet.</div>';
    return;
  }

  els.runList.innerHTML = runs
    .map(
      (run) => `
        <button class="run-button ${run.runId === state.selectedRunId ? "active" : ""}" data-run-id="${escapeHtml(run.runId)}" type="button">
          <span class="run-title">${escapeHtml(run.goal)}</span>
          <span class="meta">${escapeHtml(run.runId)}</span>
          <span class="meta">${formatTime(run.startedAt)} · ${run.stepCount} steps · ${run.artifactCount} artifacts</span>
          ${statusPill(run.status)}
        </button>
      `
    )
    .join("");

  els.runList.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedRunId = button.dataset.runId;
      state.selectedArtifactId = null;
      await loadSelectedRun();
      render();
    });
  });
}

function renderJobs() {
  const jobs = state.jobs ?? [];
  if (!jobs.length) {
    els.jobStatus.innerHTML = '<div class="empty">No dashboard-started MCP jobs yet.</div>';
    return;
  }

  const latest = jobs[0];
  const events = latest.events?.slice(-8) ?? [];
  const planSteps = latest.plan?.steps ?? [];
  const validations = latest.validations ?? [];
  const validationTotals = validations.reduce((totals, validation) => {
    totals[validation.status] = (totals[validation.status] ?? 0) + 1;
    return totals;
  }, {});
  els.jobStatus.innerHTML = `
    <article class="job-card">
      <header>
        <div>
          <strong>${escapeHtml(latest.prompt)}</strong>
          <p class="meta">${escapeHtml(latest.id)}${latest.runId ? ` · run ${escapeHtml(latest.runId)}` : ""}${latest.plannerMode ? ` · planner ${escapeHtml(latest.plannerMode)}` : ""}</p>
        </div>
        ${statusPill(latest.status)}
      </header>
      ${
        latest.plan
          ? `
            <div class="agent-plan">
              <p class="meta">${escapeHtml(latest.plan.rationale)}</p>
              <ol>
                ${planSteps
                  .map(
                    (step) => `
                      <li>
                        <strong class="code">${escapeHtml(step.tool)}</strong>
                        <span>${escapeHtml(step.purpose)}</span>
                      </li>
                    `
                  )
                  .join("")}
              </ol>
              ${
                latest.plan.warnings?.length
                  ? `<p class="meta">Warnings: ${escapeHtml(latest.plan.warnings.join(" · "))}</p>`
                  : ""
              }
            </div>
          `
          : ""
      }
      ${
        validations.length
          ? `
            <div class="validation-panel">
              <div class="validation-summary">
                <strong>Validation layer</strong>
                <span>${validations.length} checks</span>
                <span>${validationTotals.passed ?? 0} passed</span>
                <span>${validationTotals.warning ?? 0} warnings</span>
                <span>${validationTotals.recovered ?? 0} recovered</span>
                <span>${validationTotals.failed ?? 0} failed</span>
              </div>
              <div class="validation-list">
                ${validations.slice(-10).map(renderValidationRecord).join("")}
              </div>
            </div>
          `
          : ""
      }
      <div class="job-events">
        ${events
          .map(
            (event) => `
              <div class="job-event ${event.level}">
                ${formatTime(event.at)} · ${escapeHtml(event.message)}
              </div>
            `
          )
          .join("")}
      </div>
      ${latest.error ? `<pre class="final-answer error-text">${escapeHtml(latest.error)}</pre>` : ""}
      ${latest.finalAnswer ? `<pre class="final-answer">${escapeHtml(latest.finalAnswer)}</pre>` : ""}
    </article>
  `;
}

function renderProcessMap() {
  const phases = state.dashboard?.agentProcess ?? [];
  els.processMap.innerHTML = phases
    .map(
      (phase) => `
        <div class="process-step">
          <h3>${escapeHtml(phase.phase)}</h3>
          <p>${escapeHtml(phase.decision)}</p>
        </div>
      `
    )
    .join("");
}

function latestScreenshotUrl(summary) {
  return summary?.steps
    ?.map((step) => step.result?.screenshotPath)
    ?.filter(Boolean)
    ?.map((entry) => `/api/file?path=${encodeURIComponent(entry)}`)
    ?.at(-1) ?? null;
}

function renderSelectedRun() {
  const run = state.selectedRun;
  if (!run) {
    els.selectedRunTitle.textContent = "No run selected";
    els.runMetrics.innerHTML = "";
    els.screenshotFrame.innerHTML = '<div class="empty">Select a run to see screenshots and metrics.</div>';
    return;
  }

  els.selectedRunTitle.textContent = run.taskRequest.goal;
  const completed = run.steps.filter((step) => step.status === "completed").length;
  const failed = run.steps.filter((step) => step.status === "failed").length;
  const running = run.steps.filter((step) => step.status === "running").length;

  els.runMetrics.innerHTML = [
    ["Status", run.status],
    ["Steps", run.steps.length],
    ["Completed", completed],
    ["Failed", failed],
    ["Running", running],
    ["Artifacts", run.artifacts.length],
    ["Started", formatTime(run.startedAt)],
    ["Updated", formatTime(run.updatedAt)]
  ]
    .map(
      ([label, value]) => `
        <div class="metric">
          <strong class="${metricValueClass(label)}">${escapeHtml(value)}</strong>
          <span class="meta">${escapeHtml(label)}</span>
        </div>
      `
    )
    .join("");

  const screenshot = latestScreenshotUrl(run);
  els.screenshotFrame.innerHTML = screenshot
    ? `<img src="${screenshot}" alt="Latest browser screenshot for the selected run" />`
    : '<div class="empty">No screenshot was captured for this run.</div>';
}

function renderSteps() {
  const run = state.selectedRun;
  if (!run?.steps?.length) {
    els.stepTimeline.innerHTML = '<div class="empty">No steps recorded for this run.</div>';
    return;
  }

  els.stepTimeline.innerHTML = run.steps
    .map(
      (step) => `
        <article class="timeline-step">
          <div class="step-index">${step.index + 1}</div>
          <div>
            <div class="step-title">
              <h3 class="code">${escapeHtml(step.tool)}</h3>
              ${statusPill(step.status)}
            </div>
            <p class="meta">Started ${formatTime(step.startedAt)} · Attempts ${step.attemptCount}</p>
            <p class="code">Input ${jsonSnippet(step.input)}</p>
            ${step.result?.artifactIds?.length ? `<p class="meta">Artifacts ${escapeHtml(step.result.artifactIds.join(", "))}</p>` : ""}
            ${step.error ? `<p class="meta">Error ${escapeHtml(step.error.message)}</p>` : ""}
          </div>
          <div class="meta">${step.finishedAt ? formatTime(step.finishedAt) : "In progress"}</div>
        </article>
      `
    )
    .join("");
}

function renderArtifacts() {
  const run = state.selectedRun;
  if (!run?.artifacts?.length) {
    els.artifactList.innerHTML = '<div class="empty">No artifacts for this run.</div>';
    return;
  }

  els.artifactList.innerHTML = run.artifacts
    .map(
      (artifact) => `
        <button class="artifact-item ${artifact.id === state.selectedArtifactId ? "active" : ""}" data-artifact-id="${escapeHtml(artifact.id)}" type="button">
          <strong>${escapeHtml(artifact.type)}</strong>
          <p class="meta">${escapeHtml(artifact.id)}</p>
          <p class="meta">${escapeHtml(artifact.mimeType)} · ${artifact.sizeBytes} bytes</p>
        </button>
      `
    )
    .join("");

  els.artifactList.querySelectorAll("[data-artifact-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedArtifactId = button.dataset.artifactId;
      await renderArtifactPreview();
      renderArtifacts();
    });
  });
}

async function renderArtifactPreview() {
  const runId = state.selectedRunId;
  const artifactId = state.selectedArtifactId;
  if (!runId || !artifactId) {
    els.artifactTitle.textContent = "Artifact Preview";
    els.artifactPreview.textContent = "Select an artifact to inspect its stored content.";
    return;
  }

  try {
    const artifact = await fetchJson(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`);
    els.artifactTitle.textContent = artifact.type;
    els.artifactPreview.textContent = JSON.stringify(artifact, null, 2);
  } catch (error) {
    els.artifactTitle.textContent = "Artifact Preview";
    els.artifactPreview.textContent = `Could not read artifact: ${error.message}`;
  }
}

function renderPrimitives() {
  const primitives = state.dashboard?.primitives;
  const toolGroups = primitives?.tools ?? [];
  els.toolGroups.innerHTML = toolGroups
    .map(
      (group) => `
        <div class="tool-group">
          <h3>${escapeHtml(group.group)}</h3>
          ${group.tools
            .map(
              (tool) => `
                <div class="tool-row">
                  <strong class="code">${escapeHtml(tool.name)}</strong>
                  <p>${escapeHtml(tool.description)}</p>
                </div>
              `
            )
            .join("")}
        </div>
      `
    )
    .join("");

  els.resourceList.innerHTML = (primitives?.resources ?? [])
    .map(
      (resource) => `
        <div class="primitive-item">
          <strong class="code">${escapeHtml(resource.uri)}</strong>
          <p>${escapeHtml(resource.purpose)}</p>
        </div>
      `
    )
    .join("");

  els.promptList.innerHTML = (primitives?.prompts ?? [])
    .map(
      (prompt) => `
        <div class="primitive-item">
          <strong class="code">${escapeHtml(prompt.name)}</strong>
          <p>${escapeHtml(prompt.purpose)}</p>
        </div>
      `
    )
    .join("");
}

function render() {
  els.lastUpdated.textContent = `Updated ${formatTime(state.dashboard?.generatedAt)}`;
  renderServerState();
  renderJobs();
  renderRuns();
  renderProcessMap();
  renderSelectedRun();
  renderSteps();
  renderArtifacts();
  renderPrimitives();
  void renderArtifactPreview();
}

els.refreshButton.addEventListener("click", () => {
  void loadState();
  void loadJobs();
});

els.promptForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = els.promptInput.value.trim();
  if (!prompt) {
    return;
  }

  els.startRunButton.disabled = true;
  els.startRunButton.textContent = "Starting...";
  try {
    const job = await postJson("/api/agent-run", { prompt });
    state.jobs = [job, ...(state.jobs ?? [])];
    renderJobs();
    await loadState();
  } catch (error) {
    els.jobStatus.innerHTML = `<div class="empty">Could not start run: ${escapeHtml(error.message)}</div>`;
  } finally {
    els.startRunButton.disabled = false;
    els.startRunButton.textContent = "Start MCP Run";
  }
});

void loadState();
void loadJobs();
setInterval(() => {
  void loadState();
  void loadJobs();
}, 10000);
