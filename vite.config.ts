import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui()],
  build: {
    // tsc writes the server and RPC entrypoints into the same directory first.
    emptyOutDir: false,
  },
})
