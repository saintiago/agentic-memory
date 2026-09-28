/**
 * Public imports and dependency directions for the component layout.
 *
 * See docs/development.md#repository-layout-and-public-boundaries and
 * docs/architecture.md#relationships-and-replacement.
 */

const COMPONENTS = [
  "memory",
  "note-store",
  "embeddings",
  "language-model",
  "ingestion-queue",
];
const PROVIDERS = ["note-store", "embeddings", "language-model"];

const componentDirectory = (name) => `^src/${name}/`;
const anyComponentDirectory = (names) => `^src/(${names.join("|")})/`;
const privateComponentModule = (name) => `^src/${name}/(?!index\\.ts$).*`;

/** Only a component's index.ts is public to the rest of the repository. */
const publicImportRules = COMPONENTS.map((name) => ({
  name: `no-private-${name}-imports`,
  severity: "error",
  comment:
    `Only src/${name}/index.ts is public. Other components, tests, examples and ` +
    "experiments must not import its internal modules.",
  from: { pathNot: componentDirectory(name) },
  to: { path: privateComponentModule(name) },
}));

/** Memory may use provider contracts; providers do not depend on Memory or on each other. */
const directionRules = [
  {
    name: "no-provider-imports-memory",
    severity: "error",
    comment: "Provider contracts do not depend on Memory orchestration.",
    from: { path: anyComponentDirectory(PROVIDERS) },
    to: { path: componentDirectory("memory") },
  },
  {
    name: "no-upstream-imports-ingestion-queue",
    severity: "error",
    comment:
      "The durable queue consumes Memory and the provider contracts; Memory and the providers " +
      "do not depend on it.",
    from: { path: anyComponentDirectory([...PROVIDERS, "memory"]) },
    to: { path: componentDirectory("ingestion-queue") },
  },
  ...PROVIDERS.map((name) => ({
    name: `no-${name}-imports-other-providers`,
    severity: "error",
    comment: "Provider components are independent of one another.",
    from: { path: componentDirectory(name) },
    to: {
      path: anyComponentDirectory(PROVIDERS.filter((other) => other !== name)),
    },
  })),
];

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A dependency cycle prevents either side from being replaced or understood alone.",
      from: {},
      to: { circular: true },
    },
    ...publicImportRules,
    ...directionRules,
    {
      name: "no-library-imports-inspector",
      severity: "error",
      comment:
        "The local inspection host is a separate consumer process; the library never depends " +
        "on it or on its HTTP and projection dependencies.",
      from: { path: "^src/" },
      to: { path: "^inspector/" },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "^(node_modules|dist)/" },
    exclude: {
      path: "^(node_modules|dist|coverage|\\.turbo|inspector/ui/build|test/boundaries/fixtures)/",
    },
  },
};
