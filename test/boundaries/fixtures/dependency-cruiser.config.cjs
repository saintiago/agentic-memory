/**
 * Boundaries configuration for the deliberately non-conforming fixture in this directory. It
 * extends the repository configuration without its fixture exclusion, so a test can prove that the
 * rules reject a private component import instead of assuming they do.
 */
module.exports = {
  extends: "../../../.dependency-cruiser.cjs",
  options: { exclude: { path: "^node_modules/" } },
};
