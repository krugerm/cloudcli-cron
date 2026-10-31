import type { RunEventsResponse } from "../../shared/contracts.js";
import type { ScheduledRun } from "../../shared/model.js";

export interface RunHistoryHandlers {
  onRetry(runId: string): void;
  onLoadOlder?(): void;
  onSelectTask?(taskId: string | null): void;
  onLoadEvents?(runId: string): Promise<RunEventsResponse>;
}

export interface RunHistoryOptions {
  tasks?: Array<{ id: string; name: string }>;
  taskFilter?: string | null;
  hasMore?: boolean;
  loadingOlder?: boolean;
  error?: string | null;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function renderTaskFilter(options: RunHistoryOptions, handlers: RunHistoryHandlers): HTMLElement | null {
  if (!options.tasks?.length || !handlers.onSelectTask) {
    return null;
  }
  const select = document.createElement("select");
  select.name = "runsTaskFilter";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All tasks";
  select.append(all);
  for (const task of options.tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = task.name;
    select.append(option);
  }
  select.value = options.taskFilter ?? "";
  select.addEventListener("change", () => handlers.onSelectTask?.(select.value || null));
  return select;
}

function attachHistoryToggle(item: HTMLElement, run: ScheduledRun, handlers: RunHistoryHandlers): void {
  if (!handlers.onLoadEvents) {
    return;
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.dataset.action = "history";
  toggle.textContent = "History";
  const panel = document.createElement("div");
  panel.className = "wsp-run-history-panel";
  panel.hidden = true;
  let openToken = 0;

  toggle.addEventListener("click", () => {
    if (!panel.hidden) {
      panel.hidden = true;
      openToken += 1;
      return;
    }
    panel.hidden = false;
    panel.textContent = "Loading…";
    const token = ++openToken;
    void handlers.onLoadEvents!(run.id)
      .then((response) => {
        if (token !== openToken) {
          return;
        }
        panel.textContent = "";
        if (response.retryOf) {
          const retryLine = document.createElement("p");
          retryLine.textContent = `Retry of run scheduled for ${localTime(response.retryOf.scheduledFor)}`;
          panel.append(retryLine);
        }
        const list = document.createElement("ol");
        list.className = "wsp-run-events";
        for (const event of response.events) {
          const entry = document.createElement("li");
          entry.textContent = `${event.type} · ${localTime(event.at)} · ${event.source}`;
          list.append(entry);
        }
        panel.append(list);
      })
      .catch((error) => {
        if (token === openToken) {
          panel.textContent = error instanceof Error ? error.message : "Failed to load run history.";
        }
      });
  });

  item.append(toggle, panel);
}

export function renderRunHistory(
  runs: ScheduledRun[],
  handlers: RunHistoryHandlers,
  options: RunHistoryOptions = {}
): HTMLElement {
  const section = document.createElement("section");
  section.className = "run-history";
  section.innerHTML = "<h2>Recent Runs</h2>";

  const filter = renderTaskFilter(options, handlers);
  if (filter) {
    section.append(filter);
  }

  if (options.error) {
    const error = document.createElement("p");
    error.className = "wsp-feedback";
    error.setAttribute("role", "alert");
    error.textContent = options.error;
    section.append(error);
  }

  if (!runs.length) {
    const empty = document.createElement("p");
    empty.textContent = "No runs recorded yet.";
    section.append(empty);
    return section;
  }

  const list = document.createElement("ul");
  for (const run of runs) {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "wsp-run-head";

    const title = document.createElement("strong");
    title.textContent = titleCase(run.status);
    head.append(title);

    const chip = document.createElement("span");
    chip.className = "wsp-status-chip";
    chip.textContent = titleCase(run.status);
    head.append(chip);

    const meta = document.createElement("div");
    meta.className = "wsp-run-meta";

    const outcome = document.createElement("span");
    outcome.textContent = run.outcomeSummary;
    meta.append(outcome);

    const scheduled = document.createElement("span");
    scheduled.textContent = `Scheduled for: ${run.scheduledFor}`;
    meta.append(scheduled);

    if (run.failureReason) {
      const failure = document.createElement("span");
      failure.textContent = `Failure: ${run.failureReason}`;
      meta.append(failure);
    }

    item.append(head, meta);

    if (run.status === "failed" || run.status === "missed") {
      const actions = document.createElement("div");
      actions.className = "wsp-inline-actions";
      const retry = document.createElement("button");
      retry.textContent = "Retry";
      retry.addEventListener("click", () => handlers.onRetry(run.id));
      actions.append(retry);
      item.append(actions);
    }

    attachHistoryToggle(item, run, handlers);
    list.append(item);
  }
  section.append(list);

  if (options.hasMore && handlers.onLoadOlder) {
    const more = document.createElement("button");
    more.type = "button";
    more.dataset.action = "load-older";
    more.textContent = options.loadingOlder ? "Loading…" : "Load older runs";
    more.disabled = Boolean(options.loadingOlder);
    more.addEventListener("click", () => handlers.onLoadOlder?.());
    section.append(more);
  }
  return section;
}
