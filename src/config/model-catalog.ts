import { getProviders, listInstalledModels } from '../core/providers/index.js';

export interface ModelOption {
  provider: string;
  model: string;
  recommended?: boolean;
  label?: string;
}

/**
 * Every provider/model the observer can run on, flattened for a picker.
 *
 * Curated rather than exhaustive. A picker listing every model a vendor ever
 * shipped is unusable — and `--model` accepts any id, so this is a shortlist,
 * not a restriction.
 */
export function flattenModelCatalog(): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of getProviders()) {
    for (const model of provider.models) {
      options.push({
        provider: provider.id,
        model: model.id,
        label: `${model.label} (${model.id})`,
        ...(model.recommended ? { recommended: true } : {}),
      });
    }
  }
  return options;
}

/**
 * The catalog, plus whatever local models are actually installed.
 *
 * The static Ollama entries are guesses at common models; this reports what the
 * user really pulled. Best-effort — with no local runtime running the result is
 * just the static catalog, so callers need no fallback path.
 */
export async function flattenModelCatalogWithLocal(): Promise<ModelOption[]> {
  const base = flattenModelCatalog();
  const installed = await listInstalledModels();
  if (installed.length === 0) return base;

  // Real installed models replace the guessed Ollama entries entirely.
  const withoutGuesses = base.filter((o) => o.provider !== 'ollama');
  return [
    ...withoutGuesses,
    ...installed.map((m, i) => ({
      provider: 'ollama',
      model: m.id,
      label: m.label,
      // Nudge toward the first: it needs no key and keeps transcripts local.
      ...(i === 0 ? { recommended: true } : {}),
    })),
  ];
}

/** Index of provider/model in `options`, or 0 when absent. */
export function findModelOptionIndex(
  options: ModelOption[],
  provider: string,
  model: string,
): number {
  const index = options.findIndex((o) => o.provider === provider && o.model === model);
  return index === -1 ? 0 : index;
}
