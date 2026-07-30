import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Derive repo name from GITHUB_REPOSITORY (owner/repo) when running in Actions.
// Falls back to the current folder name for local builds.
const repoName = process.env.GITHUB_REPOSITORY
  ? process.env.GITHUB_REPOSITORY.split("/").pop()
  : "household-supplies-tracker";

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? `/${repoName}/` : "/",
});
