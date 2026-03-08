import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://teamchong.github.io",
  base: "/drawmode",
  integrations: [
    starlight({
      title: "drawmode",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/drawmode",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting Started", slug: "getting-started" },
        { label: "Code-First Context Management", slug: "code-first" },
        { label: "Examples", slug: "examples" },
        { label: "Iterating on Diagrams", slug: "iterating" },
        { label: "Comparison", slug: "comparison" },
        { label: "SDK Reference", slug: "sdk-reference" },
        { label: "Color Presets", slug: "color-presets" },
        { label: "Architecture", slug: "architecture" },
        { label: "Deployment", slug: "deployment" },
      ],
    }),
  ],
});
