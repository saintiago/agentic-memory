/**
 * The static layout of the inspection dashboard and the typed references to the elements the
 * controller updates. The layout contains no data; every dynamic value is written as text.
 *
 * See docs/dashboard.md#visual-behavior.
 */

/** The layout markup installed into the page root. */
export const shellMarkup = String.raw`
<header class="topbar">
  <div class="title">
    <div class="title-heading">
      <h1>Agentic Memory inspection</h1>
      <div
        class="connection-status"
        id="connection-status"
        data-state="connecting"
        role="status"
        aria-live="polite"
      >
        <span class="connection-dot" aria-hidden="true"></span>
        <span id="connection-label">Connecting</span>
      </div>
    </div>
    <p class="caption" id="graph-caption">
      Positions are an approximate embedding projection: screen distance is not an
      exact cosine distance.
    </p>
  </div>
  <div class="view-status" id="view-status">Starting the inspection host…</div>
  <div class="actions">
    <button type="button" id="refresh">Refresh graph</button>
    <button type="button" id="rebuild">Rebuild projection</button>
  </div>
</header>
<div class="notice" id="notice" hidden></div>
<main class="layout">
  <section class="graph-panel">
    <div class="graph-toolbar">
      <button type="button" id="fit-all">Fit all</button>
      <button type="button" id="fit-results">Fit results</button>
      <button type="button" id="focus-selected">Focus selected</button>
      <fieldset class="link-mode">
        <legend>Links</legend>
        <label><input type="radio" name="link-mode" value="all" checked /> All</label>
        <label><input type="radio" name="link-mode" value="focused" /> Focused on selection</label>
      </fieldset>
      <div class="legend" id="freshness-legend"></div>
    </div>
    <div class="graph-stage" id="graph-stage"></div>
    <p class="caption" id="graph-caption-footer"></p>
  </section>
  <aside class="side-panel">
    <form class="query" id="query-form">
      <label for="query">Memory request</label>
      <input id="query" name="query" type="search" autocomplete="off" />
      <div class="limits">
        <label>Direct limit <input id="limit" name="limit" type="number" min="1" step="1" /></label>
        <label>Linked limit <input id="linked-limit" name="linked-limit" type="number" min="0" step="1" /></label>
      </div>
      <div class="actions">
        <button type="submit" id="search">Search</button>
        <button type="button" id="clear-results">Clear results</button>
      </div>
    </form>
    <section class="panel">
      <h2>Results</h2>
      <div class="status" id="results-status"></div>
      <ol class="results" id="results-list"></ol>
    </section>
    <section class="panel">
      <h2>Details</h2>
      <div id="details" class="details"></div>
    </section>
    <section class="panel">
      <h2>Stored-vector comparison</h2>
      <div id="comparison" class="details"></div>
    </section>
  </aside>
</main>
`;

/** The elements the dashboard controller reads and writes. */
export interface Shell {
  readonly root: HTMLElement;
  readonly connectionStatus: HTMLElement;
  readonly connectionLabel: HTMLElement;
  readonly viewStatus: HTMLElement;
  readonly notice: HTMLElement;
  readonly graphStage: HTMLElement;
  readonly graphCaption: HTMLElement;
  readonly graphCaptionFooter: HTMLElement;
  readonly legend: HTMLElement;
  readonly refresh: HTMLButtonElement;
  readonly rebuild: HTMLButtonElement;
  readonly fitAll: HTMLButtonElement;
  readonly fitResults: HTMLButtonElement;
  readonly focusSelected: HTMLButtonElement;
  readonly linkModes: readonly HTMLInputElement[];
  readonly queryForm: HTMLFormElement;
  readonly query: HTMLInputElement;
  readonly limit: HTMLInputElement;
  readonly linkedLimit: HTMLInputElement;
  readonly clearResults: HTMLButtonElement;
  readonly resultsStatus: HTMLElement;
  readonly resultsList: HTMLOListElement;
  readonly details: HTMLElement;
  readonly comparison: HTMLElement;
}

const require = <T extends Element>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) {
    throw new Error(`The inspection UI shell is missing ${selector}.`);
  }
  return found;
};

/** Install the layout into one root element and bind its parts. */
export const installShell = (root: HTMLElement): Shell => {
  root.innerHTML = shellMarkup;
  return {
    root,
    connectionStatus: require(root, "#connection-status"),
    connectionLabel: require(root, "#connection-label"),
    viewStatus: require(root, "#view-status"),
    notice: require(root, "#notice"),
    graphStage: require(root, "#graph-stage"),
    graphCaption: require(root, "#graph-caption"),
    graphCaptionFooter: require(root, "#graph-caption-footer"),
    legend: require(root, "#freshness-legend"),
    refresh: require(root, "#refresh"),
    rebuild: require(root, "#rebuild"),
    fitAll: require(root, "#fit-all"),
    fitResults: require(root, "#fit-results"),
    focusSelected: require(root, "#focus-selected"),
    linkModes: [
      require<HTMLInputElement>(root, 'input[name="link-mode"][value="all"]'),
      require<HTMLInputElement>(root, 'input[name="link-mode"][value="focused"]'),
    ],
    queryForm: require(root, "#query-form"),
    query: require(root, "#query"),
    limit: require(root, "#limit"),
    linkedLimit: require(root, "#linked-limit"),
    clearResults: require(root, "#clear-results"),
    resultsStatus: require(root, "#results-status"),
    resultsList: require(root, "#results-list"),
    details: require(root, "#details"),
    comparison: require(root, "#comparison"),
  };
};
