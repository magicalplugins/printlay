/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_CLIP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
