import { useEffect, useState } from "react";
import { api, type EmbedConfig, type EmbeddingCatalog } from "./api";
import { IconChip } from "./icons";

/** Logo files in public/brands, by model vendor. Marks belong to their owners. */
const FILES: Record<string, string> = {
  openai: "openai",
  cohere: "cohere",
  voyage: "voyage",
  gemini: "gemini",
  mistral: "mistral",
  jina: "jina",
  baai: "baai",
  huggingface: "huggingface",
  nomic: "huggingface",
  mixedbread: "huggingface",
  microsoft: "microsoft",
  snowflake: "snowflake",
};

export const PROVIDER_VENDOR: Record<string, string> = {
  openai: "openai",
  cohere: "cohere",
  voyage: "voyage",
  google: "gemini",
  mistral: "mistral",
  jina: "jina",
};

export function BrandLogo({ vendor, size = 18, tile = false }: { vendor?: string; size?: number; tile?: boolean }) {
  const file = vendor ? FILES[vendor] : undefined;
  const box = tile ? size + 14 : size;
  return (
    <span className={`brand-logo ${tile ? "tile" : ""}`} style={{ width: box, height: box }} aria-hidden="true">
      {file
        ? <img src={`brands/${file}.svg`} alt="" width={size} height={size} draggable={false} />
        : <IconChip size={Math.round(size * 0.9)} />}
    </span>
  );
}

let pending: Promise<EmbeddingCatalog> | null = null;

/** The server's embedding providers and models, fetched once per page load. */
export function useEmbeddingCatalog() {
  const [catalog, setCatalog] = useState<EmbeddingCatalog>();
  useEffect(() => {
    let live = true;
    pending ??= api.embeddingModels();
    pending.then((c) => live && setCatalog(c)).catch(() => {
      pending = null;
    });
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}

export function ModelBadge({ embed, size = 16 }: { embed: EmbedConfig; size?: number }) {
  const catalog = useEmbeddingCatalog();
  const model = catalog?.models.find((m) => m.provider === embed.provider && m.id === embed.model);
  return (
    <span className="model-badge" title={`${embed.provider} · ${embed.model}`}>
      <BrandLogo vendor={model?.vendor ?? PROVIDER_VENDOR[embed.provider]} size={size} />
      <span>{model?.name ?? embed.model}</span>
    </span>
  );
}
