export default {
  branches: ["main", { name: "dev", prerelease: true }],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    // Comments and labels are off so the release job needs no issue or pull-request permissions.
    ["@semantic-release/github", { successComment: false, failComment: false, releasedLabels: false }],
  ],
};
