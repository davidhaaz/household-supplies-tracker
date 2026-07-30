import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoName = "household-supplies-tracker";

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? `/${repoName}/` : "/",
});
